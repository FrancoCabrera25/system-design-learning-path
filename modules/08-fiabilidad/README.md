# Módulo 08 — Fiabilidad: timeouts, reintentos y degradación

## Por qué acá

Este módulo cierra todos los *"esto se resuelve en el módulo 08"* que fui
dejando:

- **Módulo 01** — el colapso metaestable: el sistema no vuelve solo aunque la
  causa original desaparezca.
- **Módulo 02** — un cliente gRPC sin deadline agota el pool y se lleva puesto
  todo el proceso.
- **Módulo 04** — si se cae Redis, ¿te degradás o te caés?
- **Módulo 06** — reintentar sólo es seguro si la operación es idempotente.
- **Módulo 07** — el mensaje envenenado que bloquea una partición para siempre.

Todos son el mismo tema: **qué hace tu sistema cuando algo de lo que depende
está roto, lento o a medias.**

## Material de este módulo

| Archivo | Qué es |
| --- | --- |
| Este `README.md` | La teoría |
| [`quiz.md`](quiz.md) · [`respuestas.md`](respuestas.md) | Preguntas de entrevista y respuestas modelo con rúbrica |
| `amplificacion.ts` · `jitter.ts` · `circuit-breaker.ts` | Los ejemplos ejecutables |

## Teoría mínima

### 1. El fallo parcial es el caso normal

En una sola máquina, una función anda o tira una excepción. En un sistema
distribuido existe un tercer estado, y es el que domina:

> **Lento. Degradado. A medias. Respondiendo al 60%.**

Y la trampa es que **un sistema degradado suele hacer más daño que uno
caído**. Un servicio caído devuelve error rápido y tus timeouts lo absorben.
Un servicio que tarda 30 segundos en vez de 50 ms **te retiene recursos**:
conexiones, memoria, hilos del pool. Por eso el objetivo de este módulo no es
"que nada falle" —eso no existe— sino:

> **Que la falla de un componente no se convierta en la falla del sistema.**

### 2. Timeouts: el default es infinito, y es el peor

Casi todos los clientes HTTP y de base de datos tienen, por defecto, **timeout
infinito o absurdamente largo**. Eso significa que, sin configurar nada, tu
servicio está diseñado para esperar para siempre.

**Cómo elegir el valor:** mirando el **p99 de la dependencia**, no eligiendo un
número redondo.

```
timeout = p99 de la dependencia × 1,5 a 2
```

Si el p99 de un servicio es 250 ms, un timeout de 400-500 ms es razonable. Uno
de 100 ms convierte el 5% de tu tráfico normal en errores; uno de 30 segundos
no te protege de nada.

**El costo explícito, que hay que poder nombrar:** un timeout **cambia latencia
de cola por tasa de error**. En la simulación del módulo 02, bajar el timeout
mejoró el p99 de 1.900 ms a 300 ms **y empeoró la disponibilidad**, porque
rechazó requests que iban a salir bien. Por eso un timeout sin reintento es
media solución.

**Hay más de un timeout, y hay que configurarlos todos:**

| Timeout | Qué mide | Pasa seguido que... |
| --- | --- | --- |
| **Connect** | Establecer la conexión TCP/TLS | Es el único que la gente configura |
| **Read / socket** | Esperar bytes | Queda infinito |
| **Request total** | La operación completa | No existe en muchos clientes |
| **Pool acquire** | Conseguir una conexión del pool | **El que delata la saturación**, y casi nadie lo mide |

Y **los timeouts tienen que decrecer hacia adentro**. Si tu API tiene 2 s de
presupuesto, la llamada a la base no puede tener 5 s: nunca se va a cumplir, y
vas a quemar recursos en trabajo que ya nadie espera. Eso es lo que resuelven
los **deadlines propagados** de gRPC (módulo 02, A4).

### 3. Reintentos: la herramienta más peligrosa del módulo

Un reintento es gratis cuando el sistema está sano y **es gasolina cuando está
en llamas** — que es exactamente cuando se disparan.

**Qué se reintenta y qué no:**

| Reintentable | NO reintentable |
| --- | --- |
| Timeout, connection reset | `400 Bad Request`, `422` |
| `503 Service Unavailable` | `401` / `403` |
| `429` (respetando `Retry-After`) | `404` |
| `UNAVAILABLE`, `DEADLINE_EXCEEDED` (gRPC) | `INVALID_ARGUMENT`, `FAILED_PRECONDITION` |
| Deadlock de Postgres (`40P01`) | Violación de `UNIQUE` (salvo que sea tu dedup) |

Reintentar un `400` no lo arregla: sólo gasta. Y **sólo reintentás si la
operación es idempotente** (módulo 06); si no, cada reintento es una apuesta.

**Backoff exponencial con jitter.** Sin backoff, los reintentos pegan
inmediatamente sobre un servicio que ya está sufriendo. Sin **jitter**, todos
los clientes que fallaron en el mismo instante reintentan **en el mismo
instante** — y creás un pico sincronizado cada vez.

```ts
// ❌ sin jitter: todos los que fallaron juntos vuelven juntos
const espera = base * 2 ** intento;

// ✅ full jitter (el que recomienda AWS, y el que mejor funciona)
const espera = Math.random() * Math.min(TECHO, base * 2 ** intento);
```

Lo vas a medir en `jitter.ts`: el pico sincronizado es brutal, y el arreglo es
una línea.

**La amplificación en cascada — el peligro real.** Si cada capa reintenta 3
veces y tenés 3 capas:

```
A reintenta 3 × B reintenta 3 × C reintenta 3 = 27 llamadas a D
```

**Una request del usuario se convierte en 27 contra el servicio más profundo**,
que es justo el que está caído. Los reintentos **se multiplican entre capas**.

Las dos defensas:

1. **Reintentar en una sola capa.** Elegí dónde —normalmente la más cercana a
   la dependencia, o el borde— y que las demás propaguen el error.
2. **Retry budget** (presupuesto de reintentos): en vez de "3 intentos por
   request", "como máximo un 10% extra de tráfico de reintentos sobre el
   total". Cuando el sistema está sano casi no se usa; cuando todo falla, el
   presupuesto se agota y **los reintentos se apagan solos**. Es lo que hacen
   Envoy, Finagle y gRPC. **Es estrictamente mejor que un contador por
   request**, y casi nadie lo usa.

### 4. Circuit breaker

Si una dependencia está caída, seguir mandándole requests sólo sirve para
**retener tus recursos** esperando timeouts que ya sabés que van a vencer.

```
        fallos > umbral
CLOSED ───────────────────► OPEN ──── pasa el cooldown ───► HALF-OPEN
  ▲   (todo pasa normal)   (todo falla     │                (deja pasar
  │                         INMEDIATO)     │                 unas pocas)
  │                                        │                     │
  └────────── éxito ───────────────────────┴──── fallo ──────────┘
```

- **CLOSED**: operación normal, contando fallos.
- **OPEN**: **se rechaza sin intentar**. El usuario recibe un error en 1 ms en
  vez de esperar 30 segundos, y tu pool queda libre.
- **HALF-OPEN**: después de un cooldown, deja pasar unas pocas requests de
  prueba. Si andan, vuelve a CLOSED; si no, vuelve a OPEN.

**Lo que hay que entender:** el circuit breaker **no protege a la dependencia
caída: te protege a vos**. Evita que el 100% de tus recursos se quede
esperando a algo que no va a responder, y así los endpoints que **no**
dependen de ella siguen funcionando.

**Los errores comunes:**

- **Umbral por cantidad en vez de por porcentaje.** "10 fallos" se alcanza
  igual con 10 de 10 que con 10 de 100.000. Usá tasa, con un mínimo de
  volumen para que no se abra con 3 requests.
- **Abrir por errores de negocio.** Un `404` o un `422` no son fallos de la
  dependencia. Sólo cuentan timeouts, `5xx` y errores de conexión.
- **No tener fallback.** Un breaker abierto sin plan de degradación convierte
  "lento" en "error rápido", que es mejor pero sigue siendo un error.
- **Un breaker global para todo.** Si el breaker es por servicio y no por
  endpoint o por host, un endpoint lento te corta todo el servicio.

### 5. Bulkhead: aislar los recursos

El nombre viene de los **mamparos** de un barco: compartimentos estancos, para
que una vía de agua no hunda el casco entero.

El fallo que previene es el más frecuente de este módulo:

```
El servicio de recomendaciones se pone lento (30 s en vez de 50 ms)
  └─► sus requests retienen conexiones del pool compartido
       └─► el pool se agota
            └─► el CHECKOUT falla, aunque no use recomendaciones
```

**Una dependencia no crítica te tumbó la crítica, a través de un recurso
compartido.** La solución es no compartir: pools separados por dependencia,
límites de concurrencia por tipo de trabajo, o directamente procesos
separados.

```ts
// Cada dependencia tiene su propio presupuesto de concurrencia
const limites = {
  pagos:            new Semaforo(50),   // crítico: le damos la mayor parte
  recomendaciones:  new Semaforo(10),   // si se satura, se degrada SOLO
  analytics:        new Semaforo(5),
};
```

Es el mismo razonamiento que separar el consumer de backfill del de producción
(módulo 07, D1) o que tener instancias de Redis distintas para cargas con
patrones distintos (módulo 04).

### 6. Backpressure y load shedding

**Backpressure** es decirle a quien te manda trabajo que vaya más despacio.
**Load shedding** es tirar trabajo cuando no das abasto.

La regla contraintuitiva, que ya apareció en el módulo 01:

> **En sobrecarga, rechazar rápido es más sano que encolar.**

Porque una cola ilimitada **no es una cola: es una bomba de tiempo**. Si llegan
más requests de las que podés atender, la cola crece para siempre, la latencia
crece con ella, y para cuando atendés una request **el cliente ya se fue** —
hiciste el trabajo para nadie y encima el cliente reintentó.

```ts
// ❌ cola ilimitada: la latencia crece hasta que el proceso muere
await cola.push(trabajo);

// ✅ cola acotada: en saturación, rechazo rápido y el cliente lo sabe
if (cola.size >= MAX) throw new ServiceUnavailableException('Sobrecarga');
```

Y el load shedding **con prioridades** es lo que convierte una caída total en
una degradación tolerable: tirá primero bots, prefetch y analytics; protegé el
checkout y el login. Requiere clasificar el tráfico de antemano, que es trabajo
— y es exactamente la diferencia entre "se cayó todo" y "estuvimos lentos".

### 7. Degradación elegante

Cuando algo falla, hay más opciones que "error 500":

| Estrategia | Ejemplo |
| --- | --- |
| **Valor por defecto** | Recomendaciones genéricas en vez de personalizadas |
| **Servir stale** | El último valor conocido del caché, aunque esté vencido (módulo 04) |
| **Respuesta parcial** | El producto sin las reseñas, con un aviso |
| **Diferir** | Aceptar y procesar después (202, módulo 02) |
| **Modo degradado** | Apagar features caras para proteger el camino crítico |

La pregunta de diseño, que conviene hacerse por endpoint: **¿cuál es la
respuesta mínima aceptable?** Casi nunca es "nada".

### 8. Fallos metaestables

Es el concepto que viene apareciendo desde el módulo 01 y acá se nombra:

> Un sistema está en estado **metaestable** cuando **sigue en el estado malo
> aunque la causa original haya desaparecido**, porque algo del propio sistema
> lo sostiene.

El ciclo típico:

```
1. Un pico de carga (o una dependencia lenta) sube la latencia
2. Los clientes llegan al timeout y REINTENTAN
3. La carga efectiva sube: tráfico real + reintentos
4. La latencia sube más -> más timeouts -> más reintentos
5. El pico original pasa... y el sistema NO VUELVE.
   Ahora la carga son los reintentos.
```

Lo que lo caracteriza —y lo que hay que saber decir— es que **requiere
intervención manual**: cortar tráfico, vaciar colas, reiniciar en orden. El
caché que vuelve vacío (módulo 04, B3) y el loop de rebalances (módulo 07, C3)
son dos instancias del mismo fenómeno.

Las defensas son todas de este módulo: **retry budget** (corta el lazo de
realimentación), **circuit breaker** (corta el trabajo inútil), **load
shedding** (mantiene la utilización por debajo de 1), y **colas acotadas**.

### 9. Cómo se combinan (y los errores de combinarlos mal)

El orden correcto, de afuera hacia adentro:

```
request
  └─► ¿hay presupuesto / la cola tiene lugar?   -> si no: 503 RÁPIDO
       └─► ¿el breaker está cerrado?            -> si no: fallback RÁPIDO
            └─► bulkhead: ¿hay slot para esta dependencia?
                 └─► llamada con TIMEOUT
                      └─► si falla y es reintentable y hay presupuesto:
                          backoff + jitter, y vuelta a empezar
```

Los tres errores clásicos de combinación:

1. **Timeout × reintentos sin presupuesto total.** Con timeout de 3 s y 3
   reintentos, el peor caso son **9 segundos** — mucho más de lo que el
   usuario espera y de lo que tu propio deadline permite. **El presupuesto
   total manda sobre los intentos individuales.**
2. **Reintentar en todas las capas.** La amplificación 27x de la sección 3.
3. **Circuit breaker sin bulkhead.** El breaker te protege de la dependencia
   lenta... después de que su lentitud ya agotó el pool compartido. El
   bulkhead evita el daño; el breaker lo acorta.

### 10. Aplicado a tu stack

- **Node**: `undici` / `axios` con timeouts explícitos en **todos** los
  clientes. Y `AbortController` para cancelar de verdad — sin él, el `await`
  vence pero **la request sigue en vuelo** consumiendo un socket.
- **gRPC en NestJS**: deadline por llamada, siempre (módulo 02).
- **TypeORM / Prisma**: `statement_timeout` en la base **además** del timeout
  del cliente. Sin el de la base, la query sigue corriendo allá aunque tu app
  ya cortó.
- **El pool de conexiones es tu bulkhead más importante** (módulo 01, C2):
  pools separados para el camino crítico y para los jobs.
- **Kafka**: el consumer no tiene "timeout de request", tiene
  `max.poll.interval.ms` — y el reintento es el retry topic (módulo 07, C2).
- **Health checks**: `liveness` sólo el proceso, `readiness` las dependencias
  (módulo 03, A3). Un liveness que chequea la base reinicia toda la flota a la
  vez.
- **Agentes de IA** (módulo 14): un `429` del proveedor **siempre** lleva
  backoff y respeta `Retry-After`. Y el breaker evita gastar en llamadas que
  van a fallar — acá el fallo cuesta dinero, no sólo latencia.

## Lo que vas a correr

```bash
node modules/08-fiabilidad/amplificacion.ts
node modules/08-fiabilidad/jitter.ts
node modules/08-fiabilidad/circuit-breaker.ts
```

1. **`amplificacion.ts`** — la cascada de reintentos en 3 capas y el colapso
   metaestable: cuánto tarda el sistema en no volver, y cómo el retry budget
   lo corta.
2. **`jitter.ts`** — el pico sincronizado: 50.000 clientes que fallan juntos y
   reintentan juntos, con backoff pelado y con full jitter.
3. **`circuit-breaker.ts`** — una dependencia que se degrada a 30 s: con
   breaker y sin breaker, midiendo latencia, errores y uso del pool.

## Para pensar / próximo paso

- Tu API llama a 3 servicios y cada capa reintenta 3 veces. El servicio más
  profundo se cae. ¿Cuántas requests recibe? ¿Cómo lo evitás **sin** sacar los
  reintentos?
- Un endpoint que usa un servicio de recomendaciones no crítico empieza a
  tardar 30 s. **El checkout también falla.** ¿Por qué? ¿Qué patrón faltaba?
- Tu sistema se recuperó de un pico de tráfico... pero sigue devolviendo 500
  media hora después, con el tráfico ya normal. ¿Qué está pasando y cómo
  salís?

## Fuentes

- **AWS Builders' Library**, *Timeouts, retries and backoff with jitter* — la
  referencia de la sección 3:
  <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **AWS Architecture Blog**, *Exponential Backoff And Jitter* — el artículo con
  las mediciones: <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
- **Marc Brooker**, *Metastable Failures in Distributed Systems*:
  <https://brooker.co.za/blog/2021/05/24/metastable.html>
- **Bronson et al.**, *Metastable Failures in Distributed Systems* (HotOS 2021)
  — el paper: <https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf>
- **Michael Nygard**, *Release It!* — el libro que nombró el circuit breaker y
  el bulkhead.
- **Google SRE Book**, cap. *Handling Overload* y *Addressing Cascading
  Failures*: <https://sre.google/sre-book/handling-overload/>

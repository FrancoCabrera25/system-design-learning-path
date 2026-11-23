# Caso 06 — El 500 que no se va

> **Módulos:** [08 (fiabilidad)](../modules/08-fiabilidad/) ·
> [01 (fundamentos)](../modules/01-fundamentos/)
> **Patrones:** Retry budget + descarte de trabajo vencido + load shedding

---

## 1. El escenario

API de un marketplace. Un servicio de NestJS detrás de un ALB, con clientes
web y móviles que reintentan automáticamente.

```
capacidad sostenida:    1.000 req/s
carga normal:             800 req/s   (80% de utilización... ya es mucho)
timeout del cliente:        2 s
reintentos del cliente:     3, con backoff de 1 s / 2 s / 4 s
```

Un martes a las 20:15 sale una campaña de marketing con push a 2 millones de
usuarios. El tráfico salta a **1.600 req/s durante 30 segundos**.

A las 20:16 el pico terminó. El tráfico volvió a 800 req/s.

**A las 20:50 el sistema sigue devolviendo 500.**

## 2. Qué se rompe

**El síntoma, que es el que desconcierta:** el pico duró 30 segundos y hace
media hora que terminó. El tráfico de usuarios está en 800 req/s, **un 20% por
debajo de la capacidad**. Y nada funciona.

El equipo revisa todo:

- ¿Un deploy? **No**, el último fue ayer.
- ¿La base? **Sana**: CPU 30%, sin locks, sin queries lentas.
- ¿Memoria, CPU de los pods? **Normales.**
- ¿Escalamos? Se duplican los pods. **No cambia nada.**
- ¿El tráfico bajó? **Sí, hace 30 minutos.**

Y lo más desconcertante: **el servidor está trabajando a pleno.** 1.000 req/s
procesadas, CPU al 100%, los logs llenos de actividad. No parece colgado:
parece ocupadísimo.

**La causa.** El servidor está procesando a máxima velocidad **requests cuyo
cliente se fue hace rato**.

```
1. El pico satura -> la cola crece
2. Las requests esperan más que los 2 s del timeout -> EL CLIENTE SE VA
3. El cliente reintenta -> entra trabajo NUEVO a la cola
4. Y el servidor sigue masticando el trabajo VIEJO, que ya no le sirve a nadie
5. Esa capacidad desperdiciada hace que las nuevas también venzan
6. El pico desaparece... y el lazo sigue girando solo
```

La pieza que casi nadie modela, y la que explica todo:

> **Cuando el cliente llega a su timeout, se va. Pero su request SIGUE EN LA
> COLA DEL SERVIDOR, que no se enteró. El servidor la procesa igual.**

Los números de
[`amplificacion.ts`](../modules/08-fiabilidad/amplificacion.ts):

```
    t      ofrecida   ÚTIL   desperdiciada        cola
   30s          800    800               0           0
   89s       15.200      0           1.000     198.200
   95s       16.800      0           1.000     287.400   <-- el pico YA TERMINÓ
  399s       97.400      0           1.000   5.384.000
```

**Trabajo útil: CERO.** El servidor procesa 1.000 req/s, todas vencidas. La
cola llegó a 5,4 millones. La carga ofrecida es de 97.400 req/s — y los
usuarios reales siguen siendo 800.

Eso es un **fallo metaestable**: el sistema se queda en el estado malo aunque
la causa original haya desaparecido, porque **algo del propio sistema lo
sostiene**. Es el mismo fenómeno que ya apareció tres veces en este path:

| Módulo | La misma falla, otro disfraz |
| --- | --- |
| [01, §5](../modules/01-fundamentos/README.md) | La cola cuando la utilización pasa de 1: no se estabiliza, crece para siempre |
| [04, B3](../modules/04-caching/respuestas.md) | Redis vuelve **vacío**: no hay caché porque la base está saturada, y la base está saturada porque no hay caché |
| [07, C3](../modules/07-kafka/respuestas.md) | El loop de rebalances: el progreso real es cero y todo parece activo |

## 3. La solución probada

Dos frentes, y hay que separarlos:

**A corto plazo (ahora, a las 20:50): sacarlo del estado malo.** El sistema
**no sale solo**. Esto es lo que define a un fallo metaestable, y por eso hace
falta un runbook.

**A largo plazo: cortar el lazo de realimentación.** Tres cosas, en orden de
impacto:

1. **Retry budget** — los reintentos limitados a una fracción del tráfico
   **exitoso**. Cuando nada sale bien, los reintentos se apagan solos. Lo
   implementan Envoy, Finagle y gRPC.
2. **Descartar trabajo vencido en el servidor** — antes de procesar, chequear
   si el deadline de la request ya pasó. **Es la defensa más directa contra el
   trabajo zombi**, y la que elimina el lazo de raíz.
3. **Colas acotadas + load shedding con prioridades** — mantener la
   utilización por debajo de 1 rechazando rápido.

## 4. La implementación

### 4.1 El runbook: cómo sacarlo del estado malo

El principio, y el orden importa: **primero bajar la utilización por debajo de
1, después investigar.**

```
┌─ PASO 1 — CORTAR LA ENTRADA ──────────────────────────────────────┐
│ Load shedding agresivo en el borde: rechazar un % del tráfico     │
│ con 503 rápido, o rate limiting duro en el ALB/API Gateway.       │
│                                                                    │
│ Objetivo: que la carga OFRECIDA baje de la capacidad.             │
│ Es lo único que rompe el lazo. Y es lo que más cuesta hacer,      │
│ porque se siente como rendirse.                                   │
└────────────────────────────────────────────────────────────────────┘
┌─ PASO 2 — APAGAR LOS REINTENTOS ──────────────────────────────────┐
│ Feature flag, retry budget a 0, o la config del service mesh.     │
│ Si no podés, el paso 1 tiene que ser más agresivo.                │
└────────────────────────────────────────────────────────────────────┘
┌─ PASO 3 — VACIAR LAS COLAS DE TRABAJO ZOMBI  ← CASI NADIE LO HACE │
│ Purgar la cola interna, o reiniciar los workers con cola limpia.  │
│ Sin esto seguís masticando trabajo que no le sirve a nadie:       │
│ es el paso que LIBERA LA CAPACIDAD ÚTIL.                          │
└────────────────────────────────────────────────────────────────────┘
┌─ PASO 4 — RECUPERAR EL ESTADO que el fallo destruyó ──────────────┐
│ Precalentar el caché si fue la causa, reiniciar consumers en      │
│ orden, verificar que las dependencias están sanas.                │
└────────────────────────────────────────────────────────────────────┘
┌─ PASO 5 — DEVOLVER EL TRÁFICO GRADUALMENTE ───────────────────────┐
│ 10% -> 25% -> 50% -> 100%, mirando latencia y errores en cada     │
│ escalón. Abrir todo de golpe REPRODUCE el colapso.                │
│ Es el error clásico de la recuperación.                           │
└────────────────────────────────────────────────────────────────────┘
┌─ PASO 6 — RECIÉN AHORA investigar la causa original ──────────────┐
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Retry budget — del lado del cliente

```ts
/**
 * Limita los reintentos a una fracción del tráfico EXITOSO.
 *
 * La propiedad clave: es del SISTEMA, no de la request. Una request
 * individual no sabe cuántas otras están reintentando al mismo tiempo —
 * y por eso un contador de "3 intentos" nunca protege de esto.
 */
@Injectable()
export class RetryBudget {
  private readonly RATIO = 0.1;          // 10% extra como máximo
  private readonly MIN_POR_SEGUNDO = 3;  // piso para tráfico bajo
  private exitos: number[] = [];         // ventana deslizante de 10 s
  private reintentos: number[] = [];

  registrarExito() { this.push(this.exitos); }

  /** true = tenés permiso para reintentar. */
  consumir(): boolean {
    const exitosRecientes = this.contar(this.exitos);
    const reintentosRecientes = this.contar(this.reintentos);
    const techo = Math.max(this.MIN_POR_SEGUNDO * 10, exitosRecientes * this.RATIO);

    if (reintentosRecientes >= techo) {
      this.metricas.increment('retry_budget.agotado');
      return false;                      // ← acá se apaga solo
    }
    this.push(this.reintentos);
    return true;
  }

  private push(arr: number[]) { arr.push(Date.now()); }
  private contar(arr: number[]) {
    const desde = Date.now() - 10_000;
    while (arr.length && arr[0] < desde) arr.shift();
    return arr.length;
  }
}
```

```ts
async function llamarConReintentos<T>(fn: () => Promise<T>, presupuestoMs = 2_000): Promise<T> {
  const deadline = Date.now() + presupuestoMs;      // PRESUPUESTO TOTAL, no por intento
  let ultimo: unknown;

  for (let i = 0; i < 3; i++) {
    const restante = deadline - Date.now();
    if (restante <= 0) break;                        // no empieces lo que no llega

    try {
      const r = await conTimeout(fn, Math.min(700, restante));
      this.budget.registrarExito();
      return r;
    } catch (e) {
      ultimo = e;
      if (!esReintentable(e)) throw e;
      if (!this.budget.consumir()) break;            // ← el presupuesto manda
      await sleep(Math.random() * Math.min(5_000, 300 * 2 ** i));   // full jitter
    }
  }
  throw ultimo;
}
```

Dos cosas que importan acá: **el presupuesto total de latencia manda sobre los
intentos individuales** (con timeout de 3 s y 3 reintentos, el peor caso son
19 segundos — mucho más de lo que el usuario espera), y **full jitter**, porque
sin jitter todos los clientes que fallaron juntos vuelven juntos
([módulo 08, §3](../modules/08-fiabilidad/README.md)).

### 4.3 Descartar trabajo vencido — del lado del servidor

Ésta es la defensa que elimina el lazo de raíz, y es sorprendentemente simple.

```ts
/**
 * El cliente manda cuándo deja de esperar. El servidor lo respeta.
 * Si la request ya venció mientras estaba en la cola, NO SE PROCESA.
 */
@Injectable()
export class DeadlineGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();

    // El cliente lo manda; si no, se asume el default del endpoint
    const deadlineMs = Number(req.headers['x-request-deadline-ms']) || 2_000;
    const recibidaEn = Number(req.headers['x-request-start-ms']) || req.startTime;
    const edad = Date.now() - recibidaEn;

    if (edad > deadlineMs) {
      this.metricas.increment('request.descartada_por_deadline', { edad });
      // 499: el cliente cerró. No es un error nuestro.
      throw new HttpException('Deadline vencido antes de procesar', 499);
    }

    // Lo propagamos hacia adentro, para que las llamadas de abajo lo respeten
    req.deadline = recibidaEn + deadlineMs;
    return true;
  }
}
```

**Por qué esto corta el lazo:** en la simulación, el servidor gasta sus 1.000
req/s de capacidad en trabajo vencido. Con este guard, **ese trabajo se
descarta en microsegundos** y la capacidad vuelve a estar disponible para
requests vivas. La realimentación positiva deja de existir.

Es la misma idea que los **deadlines propagados de gRPC**
([módulo 02, A4](../modules/02-comunicacion-servicios/respuestas.md)): un
deadline absoluto que viaja con la request, y cada salto chequea si todavía
tiene sentido empezar.

Y aplicado a un consumer de cola, donde es todavía más valioso:

```ts
@EventPattern('order.process')
async handle(@Payload() ev: OrderEvent) {
  // Un mensaje que estuvo 10 minutos en la cola probablemente ya no sirve
  const edad = Date.now() - ev.emitidoEn;
  if (edad > ev.ttlMs) {
    this.metricas.increment('mensaje.vencido', { topic: 'order.process' });
    return;                              // ack y descarte: no gastamos capacidad
  }
  await this.procesar(ev);
}
```

### 4.4 Colas acotadas y load shedding con prioridades

```ts
@Injectable()
export class AdmissionControl {
  private readonly LIMITES = { critico: 400, normal: 300, bajo: 100 };
  private enVuelo = { critico: 0, normal: 0, bajo: 0 };

  intentarAdmitir(prioridad: keyof typeof this.LIMITES): boolean {
    if (this.enVuelo[prioridad] >= this.LIMITES[prioridad]) return false;
    this.enVuelo[prioridad]++;
    return true;
  }
  liberar(p: keyof typeof this.LIMITES) { this.enVuelo[p]--; }
}
```

```ts
// La clasificación: no todo el tráfico vale lo mismo
function prioridadDe(req: Request): 'critico' | 'normal' | 'bajo' {
  if (/^\/(checkout|payments|auth)/.test(req.path)) return 'critico';
  if (req.headers['x-prefetch'] === 'true') return 'bajo';
  if (esBot(req.headers['user-agent'])) return 'bajo';
  if (/^\/(analytics|recommendations)/.test(req.path)) return 'bajo';
  return 'normal';
}
```

**La regla contraintuitiva de la sección:**

> **En sobrecarga, rechazar rápido es más sano que encolar.** Una cola
> ilimitada no es una cola: es una bomba de tiempo. Para cuando atendés la
> request, el cliente ya se fue — hiciste el trabajo para nadie y además
> reintentó.

Y el load shedding **con prioridades** es lo que convierte una caída total en
una degradación tolerable: el checkout sigue andando mientras los bots reciben
503.

### 4.5 Y la causa de fondo: 80% de utilización no es "bien aprovechado"

El incidente fue posible porque el sistema corría al **80% de utilización**.
Con `W = S / (1 - ρ)` ([módulo 01, §5](../modules/01-fundamentos/README.md)):

| Utilización | Multiplicador de latencia |
| --- | --- |
| 50% | 2x |
| 70% | 3,3x |
| **80%** | **5x** |
| 90% | 10x |

A 800 req/s sobre una capacidad de 1.000, **un pico del 25% ya empuja la
utilización por encima de 1**. El margen del 20% no alcanzaba para absorber
una campaña de marketing anunciada.

**La regla operativa: no pasar del 60-70% de utilización sostenida.** Ese
30-40% "desperdiciado" es exactamente lo que paga los picos.

## 5. Por qué así y no de otra forma

### ❌ "Reiniciamos los pods"

Es lo primero que se hace, **funciona a veces, y por una razón que conviene
entender**: el reinicio **vacía las colas de trabajo zombi** (el paso 3 del
runbook). No arregla la causa: ejecuta un paso del runbook por accidente.

Y cuando no funciona, es porque **el tráfico sigue entrando**: los pods nuevos
reciben la avalancha de reintentos acumulados y vuelven al mismo estado en
segundos. Sin el paso 1 (cortar la entrada), reiniciar es patear la lata.

Peor: reiniciar todos a la vez te deja **sin capacidad** mientras arrancan, y
el arranque simultáneo contra la base es su propio *thundering herd*.

### ❌ "Escalamos horizontalmente"

En la simulación, la carga ofrecida llegó a **97.400 req/s** con 800 usuarios
reales. **No hay cantidad de pods que absorba eso**, porque la carga **la
genera el propio sistema**: más capacidad procesa más trabajo zombi un poco
más rápido, y el lazo sigue girando.

Escalar es la respuesta correcta a *"tengo más tráfico"*. Esto no es más
tráfico: es **amplificación**.

### ❌ "Subimos el timeout del cliente"

Suena razonable —"si esperara más, le llegaría la respuesta"— y **empeora
todo**:

- Las requests esperan más → **la concurrencia en vuelo crece** (Little) →
  más memoria, más sockets, más conexiones del pool retenidas.
- El trabajo zombi se vuelve **más viejo** antes de descartarse.
- Y no cambia nada de fondo: la capacidad sigue siendo 1.000 req/s.

Lo que hay que subir no es el timeout: es la **cantidad de trabajo útil por
unidad de capacidad**.

### ❌ "Sacamos los reintentos"

Resuelve este incidente y **rompe el caso normal**. Los reintentos existen
porque las fallas transitorias son reales y frecuentes: sin ellos, cada hipo
de la red es un error para el usuario.

**El problema no son los reintentos: es que no tienen presupuesto.** El retry
budget te da las dos cosas — reintentos cuando el sistema está sano, cero
reintentos cuando está en llamas.

### ❌ "Backoff exponencial y listo"

Ya lo tenían (1 s, 2 s, 4 s) y **no alcanzó**, por dos motivos:

1. **Sin jitter.** Todos los clientes que fallaron en el mismo instante
   calculan la misma espera y **vuelven todos juntos**. El backoff mueve el
   pico, no lo aplana: en la simulación el pico de reintentos es idéntico al
   de no tener backoff, y el 88% de los clientes termina rindiéndose
   ([`jitter.ts`](../modules/08-fiabilidad/jitter.ts)).
2. **Sin presupuesto global.** El backoff controla *cuándo* reintenta cada
   cliente, no *cuántos* reintentan en total.

### ❌ "Una cola más grande para absorber el pico"

Es la intuición exactamente invertida. Una cola más grande significa:

- Requests que esperan **más** → más vencen → más reintentos.
- Más trabajo zombi acumulado → **menos capacidad útil**.
- La latencia crece con la cola, así que la cola **acelera** el colapso.

> **Las colas absorben ráfagas, no sobrecarga sostenida.** Si la tasa de
> llegada supera la capacidad, ninguna cola alcanza: sólo cambia cuánto tardás
> en darte cuenta.

### ⚠️ "Autoescalado más agresivo"

Ayuda con los picos **anunciados** y no con esto: el tiempo de reacción del
autoescalado es de 2 a 5 minutos (detectar + decidir + arrancar + calentar) y
el pico duró 30 segundos ([módulo 03, B5](../modules/03-escalabilidad/respuestas.md)).

**El autoescalado sirve para tendencias, no para picos.** Los picos se
absorben con margen de capacidad o con una cola acotada que los aplane.

Y para una campaña de marketing **conocida de antemano**, la respuesta correcta
es pre-escalar: no hay nada de malo en saber que va a venir.

## 6. Cómo sabés que funciona

**La métrica que no existía y que habría hecho obvio el diagnóstico:**

```promql
# Goodput: trabajo ÚTIL, no trabajo total
rate(http_requests_total{estado="completada_a_tiempo"}[1m])
  /
rate(http_requests_total[1m])
```

En el incidente, el throughput estaba en 1.000 req/s (perfecto) y **el
goodput en 0**. Un dashboard que mide "requests por segundo" muestra un
sistema sanísimo. **El goodput es la única métrica que muestra el problema.**

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **Goodput / throughput** | Qué fracción del trabajo sirve | **< 90%** |
| **Requests descartadas por deadline** | Trabajo zombi evitado | Si es > 0 sostenido, estás saturado |
| **Edad de la request al empezar a procesarla** (p99) | Cuánto esperó en la cola | **> 20% del timeout** |
| **`retry_budget.agotado`** | El presupuesto está cortando | Cualquier valor ≠ 0 es una señal temprana |
| **Ratio reintentos / requests totales** | Amplificación | **> 15%** |
| **Utilización sostenida** | El margen para el próximo pico | **> 70%** |

La tercera es la más útil para prevenir: **si una request espera en la cola más
del 20% de su timeout, el sistema ya está en la zona de riesgo** — mucho antes
de que algo falle.

**Cómo lo testeás.** Esto se prueba con un test de carga que reproduce la
forma del incidente, no con un unit test:

```ts
it('se recupera después de un pico, sin intervención', async () => {
  const carga = nuevaCarga({ capacidadServidor: 1_000 });

  await carga.correr({ rps: 800, durante: 60 });      // normal
  await carga.correr({ rps: 1_600, durante: 30 });    // el pico
  await carga.correr({ rps: 800, durante: 300 });     // vuelve a normal

  // LA aserción del caso: 60 s después del pico, el goodput está recuperado
  const final = carga.ventana({ desde: 150, hasta: 390 });
  expect(final.goodput).toBeGreaterThan(0.99);
  expect(final.colaPendiente).toBeLessThan(1_000);
});

it('el retry budget se agota cuando todo falla', async () => {
  dependencia.caer();
  await carga.correr({ rps: 500, durante: 30 });
  // Sin budget: ~1.500 req/s al servicio caído. Con budget: ~550.
  expect(dependencia.requestsRecibidas / 30).toBeLessThan(600);
});
```

El primero es un **test de recuperación**, y es el que ninguna suite tiene. Un
sistema puede pasar todos los tests de carga (que miden el estado estable) y
tener un fallo metaestable, porque **el fallo está en la transición**.

**Game day:** inyectar el pico en producción, en horario de baja carga, y
confirmar que el goodput vuelve solo. Es la única forma de saber que la
configuración sigue vigente seis meses después.

## 7. El costo

1. **Más errores en el caso normal.** El load shedding rechaza requests que
   habrían salido bien. Es un intercambio explícito: **un 1% de 503 rápidos
   para evitar un 100% de caída**. Hay que poder defenderlo ante Producto.
2. **El retry budget hace que algunos reintentos legítimos no ocurran.** En
   sobrecarga, un usuario con un hipo transitorio no reintenta. Es deliberado.
3. **Capacidad "desperdiciada" por diseño.** Correr al 60-70% en vez del 85%
   significa pagar más instancias. **Ese margen ES la protección**, y hay que
   defenderlo cuando alguien proponga "optimizar costos".
4. **El deadline hay que propagarlo por todo el sistema**: headers, clientes
   gRPC, mensajes de cola. Es plumbing en muchos lugares.
5. **La clasificación de prioridades es trabajo de producto**, no de infra:
   alguien tiene que decidir qué tráfico se tira primero, y firmarlo.
6. **El runbook hay que mantenerlo y ensayarlo.** Un runbook de hace dos años
   que nadie probó es peor que no tenerlo: da falsa confianza a las 3 AM.

**Y lo más barato de todo, que es lo primero que hay que hacer:** bajar la
utilización sostenida al 60-70%. El incidente fue posible porque el sistema
corría al 80% y un pico del 25% lo pasó de 1. **Ningún patrón de este caso
hace falta si hay margen.**

---

## Fuentes

- **Bronson et al.**, *Metastable Failures in Distributed Systems* (HotOS 2021)
  — el paper que nombró el fenómeno:
  <https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf>
- **Marc Brooker**, *Metastable Failures in Distributed Systems*:
  <https://brooker.co.za/blog/2021/05/24/metastable.html>
- **AWS Builders' Library**, *Timeouts, retries and backoff with jitter*:
  <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **AWS Builders' Library**, *Using load shedding to avoid overload*:
  <https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/>
- **gRPC**, *Client retries* — el diseño del retry budget:
  <https://github.com/grpc/proposal/blob/master/A6-client-retries.md>
- **Google SRE Book**, *Handling Overload* y *Addressing Cascading Failures*:
  <https://sre.google/sre-book/handling-overload/>

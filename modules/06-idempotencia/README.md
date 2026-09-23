# Módulo 06 — Consistencia y coordinación: idempotencia, locks y fencing

## Por qué acá

Este módulo salda la deuda de los cinco anteriores. Contá las veces que
quedó pendiente:

- **Módulo 01** — un reintento contra un LLM cuesta dólares reales.
- **Módulo 02** — el outbox **garantiza** duplicados; sin consumidor
  idempotente cambiaste "perder eventos" por "procesarlos dos veces".
- **Módulo 03** — el `@Cron` que factura, y el lock de Redis con sus
  problemas.
- **Módulo 04** — el single-flight es un lock distribuido, con todo lo que eso
  implica.
- **Módulo 05** — dos requests con la misma `Idempotency-Key`, y los deadlocks
  que hay que reintentar (y reintentar sólo es seguro si es idempotente).

Todo desemboca acá. Y todo sale de **un solo hecho incómodo**.

## Material de este módulo

| Archivo | Qué es |
| --- | --- |
| Este `README.md` | La teoría |
| [`quiz.md`](quiz.md) · [`respuestas.md`](respuestas.md) | Preguntas de entrevista y respuestas modelo con rúbrica |
| `idempotencia.ts` · `fencing.ts` · `entrega.ts` | Los ejemplos ejecutables |

## Teoría mínima

### 1. El hecho del que sale todo: el timeout ambiguo

```
  Servicio A  ──── POST /cobrar ────►  Servicio B
              ◄─────── ??? ──────────
                  (timeout a los 5 s)
```

**A no puede distinguir entre estos tres casos:**

1. La request nunca llegó a B.
2. B la procesó **con éxito** y la respuesta se perdió.
3. B todavía la está procesando.

No es una limitación de tu stack: es un resultado teórico. En una red
asíncrona **no existe** forma de distinguir un nodo caído de uno lento
(es el mismo hecho que hace imposible el consenso con un solo fallo — el
resultado de *FLP impossibility*).

Entonces A tiene exactamente dos opciones, y las dos son malas:

| | Qué hace | Riesgo |
| --- | --- | --- |
| **No reintentar** (*at-most-once*) | Devuelve error | **Perdés operaciones** que sí ocurrieron o que podrían haber ocurrido |
| **Reintentar** (*at-least-once*) | Manda de nuevo | **Duplicás** operaciones |

> **No hay una tercera opción. Y por eso la idempotencia no es "una buena
> práctica": es la única forma de que "reintentar" sea una decisión segura.**

La receta completa, que es lo que este módulo construye:

```
at-least-once  +  operación idempotente  =  "effectively once"
```

Eso es lo más cerca de *exactly-once* que se puede llegar (sección 8).

### 2. Qué es realmente idempotente

La definición que casi todos dan es incorrecta:

> ❌ *"Idempotente es que la segunda vez no haga nada."*
> ✅ **"Idempotente es que el estado final del sistema sea el mismo, se
> ejecute una vez o cien."**

La diferencia importa: una operación puede "hacer algo" cada vez y seguir
siendo idempotente.

```sql
UPDATE cuentas SET saldo = 100 WHERE id = 1;      -- ✅ idempotente (absoluto)
UPDATE cuentas SET saldo = saldo + 50 WHERE id=1; -- ❌ NO (delta)

DELETE FROM sesiones WHERE id = 'x';              -- ✅ idempotente
INSERT INTO eventos (...) VALUES (...);           -- ❌ NO
INSERT ... ON CONFLICT DO NOTHING;                -- ✅ idempotente

redis.set('k', 'v')                               -- ✅
redis.incr('contador')                            -- ❌
```

**Los verbos HTTP** dicen la teoría: `GET`, `PUT`, `DELETE` y `HEAD` son
idempotentes; `POST` y `PATCH` no. Pero eso describe **la semántica que
deberías implementar**, no lo que tu código hace. Un `PUT /usuarios/1` que
por dentro haga `INSERT INTO historial` no es idempotente, diga lo que diga
el verbo.

Y el matiz que se pregunta: **idempotente ≠ seguro (*safe*)**. `GET` es
*safe* (no modifica nada). `DELETE` es idempotente pero no *safe*. `PUT` es
idempotente pero no *safe*.

### 3. Las tres formas de conseguirla

**(a) Diseñar la operación para que lo sea.** La mejor, cuando se puede.

```
❌ POST /carrito/items/123/incrementar        (delta)
✅ PUT  /carrito/items/123  { cantidad: 3 }   (absoluto)
```

Si el cliente manda el **estado deseado** en vez de la **transición**,
reintentar es gratis. Vale para APIs, para eventos y para infraestructura —
es, literalmente, por qué Terraform y Kubernetes son declarativos.

**(b) Deduplicación por clave.** Cuando la operación no puede ser absoluta
(cobrar, mandar un mail, crear una orden): le adosás un identificador único y
guardás cuáles ya procesaste.

```sql
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,   -- <-- el UNIQUE es la garantía, no tu código
  ...
);
```

**(c) Máquina de estados.** Cuando el dominio ya tiene estados, la
transición inválida se rechaza sola:

```sql
UPDATE ordenes SET estado = 'PAGADA'
 WHERE id = $1 AND estado = 'PENDIENTE';   -- la segunda vez afecta 0 filas
```

Es elegante, no necesita tabla extra, y además te documenta el flujo. Su
límite: sólo sirve si la operación **cambia de estado**; no cubre "mandar el
mail", que no deja rastro en la entidad.

### 4. La clave de idempotencia, en detalle

Las seis decisiones que hay que tomar, y que casi nadie toma
explícitamente:

**1. ¿Quién la genera? El cliente.** Y esto es contraintuitivo: si la
generara el servidor, el cliente no tendría forma de repetirla al reintentar
—que es justamente para lo que sirve—. El cliente genera un UUID **por
intención de negocio** y lo repite en cada reintento de *esa* intención.

Corolario que rompe implementaciones: **la clave no se regenera en el
reintento**. `axios-retry` con un interceptor que crea un `uuid()` nuevo por
intento anula toda la protección. Es el bug más común de esta sección.

**2. ¿Cuál es su alcance?** `(clave, endpoint, usuario/tenant)`. Sólo la
clave a secas permite que el cliente A reutilice (o adivine) la de B, y que
la misma clave sirva para dos endpoints distintos. **Es un problema de
seguridad, no sólo de corrección.**

**3. ¿Cuánto dura?** Lo suficiente para cubrir todos los reintentos posibles:
24 horas es lo habitual (Stripe usa 24 h). Demasiado corto, y un reintento
tardío duplica. Demasiado largo, y la tabla crece sin control — se limpia con
un job o con particionado por día.

**4. ¿Qué se guarda?** La clave, el **estado** (`IN_PROGRESS` / `COMPLETED` /
`FAILED`), la **respuesta** original, y un **hash del request**.

**5. ¿Qué devolvés si la clave ya existe?**

| Situación | Respuesta |
| --- | --- |
| `COMPLETED`, mismo request | **La respuesta original guardada**, con el mismo status |
| `IN_PROGRESS` | **`409 Conflict`** + `Retry-After` — hay una en curso |
| Misma clave, **request distinto** | **`422`** — el cliente tiene un bug |

Ese último caso es el que separa una implementación seria de una de juguete:
si alguien manda la misma clave con `{monto: 100}` y después con
`{monto: 5000}`, devolverle la respuesta del primero es **peor** que fallar.
Por eso se guarda el hash del request.

**6. ¿Dónde vive la fila `IN_PROGRESS`?** En **su propia transacción corta,
commiteada antes de empezar el trabajo**. Si la insertás dentro de la
transacción larga que procesa el pago, el `INSERT` de la segunda request se
queda **bloqueado** esperando el commit de la primera — con un pago de 4
segundos, una conexión del pool tomada 4 segundos sin hacer nada. Bajo carga,
eso agota el pool (módulo 01, C2).

### 5. El caso difícil: efectos que no controlás

Todo lo anterior funciona porque la marca y el efecto comparten transacción.
**¿Y si el efecto es una API externa?**

```ts
// Si el proveedor soporta idempotencia: usala, con clave DETERMINÍSTICA
await stripe.charges.create(datos, { idempotencyKey: `order-${orderId}-charge` });
//                                                    ^ derivada, no un uuid() nuevo
```

Si **no** la soporta (pasa seguido con APIs viejas), el patrón es **registrar
la intención antes de ejecutar**:

```
1. INSERT intento (estado = PENDIENTE, clave única)     <- COMMIT
2. llamar a la API externa
3. UPDATE intento (estado = HECHO, respuesta)           <- COMMIT
```

Si el proceso muere entre 1 y 3, al reintentar encontrás un `PENDIENTE` y
sabés que **puede** haberse ejecutado. Ahí **consultás al proveedor**
(`GET /charges?reference=...`) antes de reintentar a ciegas. No es elegante,
pero es lo que hay — y saber explicarlo vale mucho.

Y cuando ni eso se puede: **reconciliación**. Un job que compara los dos lados
y reporta las diferencias. Feo, imprescindible, y es lo que hacen los sistemas
de pagos de verdad.

### 6. Consistencia eventual: qué garantías podés pedir

"Eventual" no es una sola cosa. Hay un menú, de más débil a más fuerte:

| Garantía | Qué promete | Se rompe cuando... |
| --- | --- | --- |
| **Eventual** | Si dejan de escribir, en algún momento convergen | Siempre es lo mínimo |
| **Read-your-writes** | Vos ves **tus** escrituras | Leés de una réplica atrasada (módulo 05, C4) |
| **Monotonic reads** | Nunca ves ir el tiempo para atrás | Dos lecturas van a réplicas distintas con lag distinto |
| **Consistencia causal** | Si A causó B, nadie ve B sin A | La respuesta llega antes que el comentario |
| **Linealizable** | Como si hubiera una sola copia | Caro: exige coordinación en cada operación |

Lo importante: **son por operación, no por sistema**. El perfil que acabás de
editar necesita read-your-writes; el listado de productos no. Plantearlo así
—endpoint por endpoint— es lo que distingue una respuesta de senior.

La anomalía más visible para un usuario es la de **monotonic reads**: ve un
comentario, refresca, y **desapareció**. Se arregla pegando cada sesión a la
misma réplica (*sticky reads*).

### 7. Locks distribuidos: para qué sirven de verdad

**La pregunta que hay que hacer siempre antes de poner un lock:**

> **¿Es por eficiencia o por corrección?**

- **Eficiencia**: evitar trabajo repetido. Si el lock falla, se hace dos veces
  el trabajo y no pasa nada grave (el single-flight del módulo 04). **Redis
  alcanza.**
- **Corrección**: si dos lo hacen a la vez, se corrompe algo. **Un lock
  distribuido NO alcanza. Nunca.**

Y acá está el resultado más importante del módulo:

#### Por qué un lock con TTL no garantiza exclusión mutua

```
Cliente 1 ──[toma el lock, TTL 10 s]──► ¡PAUSA DE GC DE 15 SEGUNDOS!
                                                             │
Lock expira a los 10 s                                       │
Cliente 2 ──[toma el lock]──► escribe ──────────────────────┐│
                                                            ││
Cliente 1 despierta, CREE que todavía tiene el lock ─────────┴┴──► escribe
                                                 💥 los dos escribieron
```

El cliente 1 **no hizo nada mal**: le tocó una pausa de GC, o el nodo se
suspendió, o la red se puso lenta. **No hay forma de que un proceso sepa
cuánto tiempo pasó mientras estaba congelado.** Y esto no es teórico: una
pausa de *stop-the-world* de varios segundos en un heap grande es rutina.

Redlock —el algoritmo de Redis con N nodos— **no resuelve esto**, porque el
problema no está en cómo se adquiere el lock sino en qué pasa **después**. Es
el centro de la crítica de Martin Kleppmann, y conviene poder explicarla.

#### La solución: fencing tokens

Cada vez que se otorga el lock, se entrega un **número creciente**. El
recurso protegido **rechaza cualquier escritura con un token menor al último
que vio**.

```
Cliente 1 toma el lock  -> token 33   [congelado]
Cliente 2 toma el lock  -> token 34   escribe con 34  ✅  (el storage anota 34)
Cliente 1 despierta     -> escribe con 33  ❌ RECHAZADO (33 < 34)
```

Dos cosas que hay que decir sobre esto:

1. **El recurso tiene que participar.** El fencing no vive en el lock: vive en
   el **storage**. Si tu base no compara tokens, no hay fencing. En Postgres
   se implementa con una columna de versión (`WHERE version < $token`), que es
   el lock optimista del módulo 05 — **son el mismo mecanismo**.
2. **Si el recurso puede comparar tokens, muchas veces ya no necesitás el
   lock**: la comparación sola te da la corrección. El lock pasa a ser una
   optimización para no desperdiciar trabajo.

Lo vas a medir en `fencing.ts`.

### 8. "Exactly-once" es casi siempre mentira

Las tres semánticas:

| | Garantía | Cuándo se usa |
| --- | --- | --- |
| **At-most-once** | Cero o una vez. **Puede perder** | Métricas, telemetría, logs |
| **At-least-once** | Una o más. **Puede duplicar** | El default de todos los brokers |
| **Exactly-once** | Exactamente una | **No existe de punta a punta** |

**Por qué no existe:** volvé a la sección 1. El emisor no puede saber si el
receptor procesó el mensaje. Cualquier protocolo que lo intente necesita un
ack, y **el ack también se puede perder**. Es turtles all the way down.

Lo que sí existe, y hay que saber nombrar con precisión:

- **"Effectively once"** = at-least-once + **procesamiento idempotente**.
  Los duplicados llegan y **no producen efecto**. Es lo que buildeás vos, y es
  la respuesta correcta a la pregunta.
- **Exactly-once de Kafka (EOS)**: real, pero **sólo dentro de Kafka**. Cubre
  el ciclo *consumir → transformar → producir* atómicamente entre topics, con
  productor idempotente y transacciones. **No cubre tu escritura a Postgres ni
  tu llamada a Stripe** — en cuanto el efecto sale de Kafka, la garantía se
  termina. Confundir esto es el error clásico.

La frase para una entrevista:

> **"Exactly-once de punta a punta no existe. Lo que se construye es
> at-least-once con consumidores idempotentes, que da 'effectively once'. La
> garantía no vive en el broker: vive en el efecto."**

### 9. Leader election

Cuando algo tiene que hacerlo **uno solo** (el publisher del outbox, un
scheduler, un compactador), tenés tres caminos:

| Opción | Cómo | Cuándo |
| --- | --- | --- |
| **Sacarlo del proceso replicado** | `CronJob` de k8s, EventBridge + cola | **El default.** Módulo 03, C1 |
| **Advisory lock de Postgres** | `pg_try_advisory_lock(hash)` | Ya tenés Postgres. **Sin TTL que calibrar**: se libera si la sesión muere |
| **etcd / ZooKeeper / Consul** | Lease + watch, con consenso Raft/ZAB | Cuando la corrección importa de verdad |

El advisory lock es el punto dulce que casi nadie usa: no tiene TTL que
calibrar (el problema de la sección 7 no desaparece, pero Postgres detecta la
conexión muerta), vive en el mismo sistema transaccional que tus datos, y no
agrega infraestructura.

Y **aun con leader election, el trabajo tiene que ser idempotente**: durante
un cambio de líder puede haber, brevemente, dos que se creen líderes. Otra vez
la sección 7.

### 10. Aplicado a tu stack

**Interceptor de idempotencia en NestJS** — el esqueleto real:

```ts
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'];
    if (!key) throw new BadRequestException('Idempotency-Key requerida');

    const scope = `${req.user.tenantId}:${req.route.path}:${key}`;
    const hash = sha256(JSON.stringify(req.body));

    // Transacción CORTA y propia (sección 4.6)
    const previa = await this.store.claim(scope, hash);
    if (previa?.status === 'COMPLETED') {
      if (previa.hash !== hash) throw new UnprocessableEntityException('Clave reusada con otro payload');
      return of(previa.response);                       // la respuesta original
    }
    if (previa?.status === 'IN_PROGRESS') throw new ConflictException('En curso');

    return next.handle().pipe(
      tap((res) => this.store.complete(scope, res)),
      catchError((e) => { this.store.fail(scope); throw e; }),
    );
  }
}
```

**Consumer de Kafka idempotente** — marca y efecto en la misma transacción
(módulo 02, `para-pensar.md` §2.3).

**Agentes de IA** (módulo 14): cada tool-call lleva una clave **derivada
determinísticamente** — `hash(messageId + stepIndex + toolName + args)` — para
que reanudar el bucle desde el paso 3 no re-ejecute los pasos 1 y 2. Eso
convierte el bucle en **reanudable**, que es lo que querés cuando un paso
tarda 40 s y el pod se puede reciclar en el medio. Es el mismo problema que
resuelve un motor de workflows durables (Temporal, Step Functions).

## Lo que vas a correr

```bash
node modules/06-idempotencia/idempotencia.ts
node modules/06-idempotencia/fencing.ts
node modules/06-idempotencia/entrega.ts
```

1. **`idempotencia.ts`** — reintentos sobre timeouts ambiguos, con cuatro
   implementaciones: sin protección, `SELECT` antes del `INSERT` (la que casi
   todos escriben), `UNIQUE` + `ON CONFLICT`, y máquina de estados. Cuenta
   cobros duplicados y plata perdida.
2. **`fencing.ts`** — el escenario de la pausa de GC: un lock con TTL que
   expira mientras su dueño está congelado. Con y sin fencing token.
3. **`entrega.ts`** — at-most-once vs at-least-once vs "effectively once",
   con el costo en dólares de un agente de IA que re-ejecuta tool-calls.

## Para pensar / próximo paso

- Tu cliente móvil hace `POST /pagos` y se corta el 4G. Reintenta. ¿Qué tiene
  que haber pasado —en el cliente y en el servidor— para que el usuario no
  pague dos veces? Enumerá **todo** lo que hace falta, de punta a punta.
- Usás un lock de Redis para que sólo un pod procese un archivo. Un pod
  sufre una pausa de GC de 12 segundos con un TTL de 10. ¿Qué pasa? ¿Y si el
  archivo se escribe en S3?
- Tu consumer de Kafka es idempotente por `eventId`. Kafka rebalancea y
  reprocesa 5.000 mensajes. Todo bien. Ahora el handler, además de escribir en
  Postgres, **llama a un LLM que cuesta USD 0,02 por llamada**. ¿Sigue estando
  todo bien?

## Fuentes

- **Martin Kleppmann**, *How to do distributed locking* — la crítica a Redlock
  y el origen de los fencing tokens:
  <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Redis**, *Distributed Locks with Redis* (la otra campana):
  <https://redis.io/docs/latest/develop/use-cases/patterns/distributed-locks/>
- **Stripe**, *Idempotent requests* — el contrato de referencia:
  <https://docs.stripe.com/api/idempotent_requests>
- **AWS Builders' Library**, *Making retries safe with idempotent APIs*:
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
- **Confluent**, *Exactly-once semantics in Kafka* — qué cubre y qué no:
  <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **Kleppmann**, *DDIA* cap. 9 (consistencia y consenso), y cap. 11 §
  *Exactly-once message processing*.

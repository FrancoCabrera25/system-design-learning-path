# Para pensar — Módulo 03, resuelto

Las tres preguntas del final del README. Si querés intentarlas, cerrá esto.

---

## 1. El `@Cron()` que factura, de 1 a 4 pods — resuelto SIN lock de Redis

### 1.1 Qué pasa el 1 del mes

Los 4 pods tienen el mismo `@Cron('0 3 1 * *')` registrado, porque el
decorador se evalúa **en cada proceso**. A las 3 AM, los 4 se despiertan y los
4 arrancan a facturar.

Tres desenlaces posibles, de menos a más grave:

- **Si hay un `UNIQUE (cliente_id, periodo)`**: tres pods fallan con errores
  de clave duplicada. Ruido en los logs, nada roto. *(Adelanto: esto no es un
  accidente feliz, es la solución — sección 1.3.)*
- **Si no hay unicidad pero sí un `WHERE ya_facturado = false`**: los 4 leen
  la misma lista antes de que ninguno la marque, y facturan 4 veces. Clásico
  *read-modify-write* sin atomicidad (módulo 04, C2 — el mismo bug con otra
  ropa).
- **Si además cada factura dispara un cobro**: **cobrás cuatro veces a cada
  cliente**. Eso ya no es un bug técnico: es contable y legal.

Y hay un cuarto efecto que se nota menos y duele: los 4 pods corren la misma
query pesada sobre toda la tabla de clientes al mismo tiempo, así que la base
se lleva **4x** la carga del proceso más pesado del mes.

### 1.2 Por qué no quiero el lock de Redis

En `respuestas.md` (C1) está el código del lock y sus cuatro problemas. El
resumen: el lock introduce un **TTL que hay que calibrar** contra la duración
de un trabajo que no sabés cuánto va a tardar, y si el pod muere con el lock
tomado, **nadie factura este mes**. Cambiaste "facturar de más" por "no
facturar", que en un cron mensual es igual de malo y mucho más difícil de
detectar.

Además: agregás una dependencia (Redis) al camino crítico de un proceso
contable.

### 1.3 La solución de fondo: que ejecutar N veces sea inofensivo

Antes de sacar el cron del proceso, el arreglo más importante es otro, y es
un cambio de mentalidad:

> **No intentes evitar que se ejecute N veces. Hacé que ejecutarlo N veces dé
> el mismo resultado que ejecutarlo una.**

```sql
CREATE TABLE facturas (
  id          uuid PRIMARY KEY,
  cliente_id  uuid NOT NULL,
  periodo     text NOT NULL,          -- '2026-10'
  total_cents bigint NOT NULL,
  UNIQUE (cliente_id, periodo)        -- <-- la garantía real
);
```

```ts
async facturarCliente(clienteId: string, periodo: string) {
  const insert = await this.db
    .createQueryBuilder().insert().into(Factura)
    .values({ id: ulid(), clienteId, periodo, totalCents: await this.calcular(clienteId, periodo) })
    .orIgnore()                      // ON CONFLICT (cliente_id, periodo) DO NOTHING
    .execute();

  if (insert.identifiers.length === 0) return;   // ya estaba facturado: listo
  await this.cobrar(clienteId, periodo);          // con Idempotency-Key = `${clienteId}:${periodo}`
}
```

Corran 4 pods, 40 o 400: **por cada `(cliente, periodo)` sólo un `INSERT`
gana**, porque quien serializa es el índice único de Postgres, no tu código.
Los otros tres pods hacen trabajo redundante (leen, calculan, fallan el
insert) pero **no producen ningún efecto duplicado**.

Esto es mejor que cualquier lock por una razón de fondo: **un lock reduce la
probabilidad de la ejecución duplicada; la unicidad elimina su consecuencia.**
Y la ejecución duplicada va a pasar igual por otros caminos que el lock no
cubre — un reintento manual, un redeploy, alguien que corre el job a mano
para "arreglar" algo.

*(Ojo: `cobrar()` tiene que ser idempotente también, con una clave
determinística. Si no, el `INSERT` ganador puede fallar después del cobro y el
reintento cobra de nuevo. Módulo 06.)*

### 1.4 Sacar el scheduler del proceso replicado

Con la idempotencia resuelta, el resto es higiene: que **una sola cosa**
dispare el trabajo.

**Opción A — `CronJob` de Kubernetes.** La más directa si ya estás en k8s:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: facturacion-mensual }
spec:
  schedule: "0 3 1 * *"
  concurrencyPolicy: Forbid        # si el anterior sigue corriendo, no arranca otro
  startingDeadlineSeconds: 3600    # si el cluster estaba caído, se recupera
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 3              # reintentos gratis
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: facturacion
              image: mi-api:1.42.0
              command: ["node", "dist/jobs/facturar.js"]
```

Kubernetes crea **un Job con un pod**. El scheduler ya no vive en un proceso
replicado: vive en el control plane. Y gratis te llevás reintentos
(`backoffLimit`), aislamiento de recursos (el job pesado no compite con el
tráfico de la API), y visibilidad (`kubectl get jobs`).

Dos detalles que definen si funciona: **`concurrencyPolicy: Forbid`** (si no,
el mes que el job tarde más de lo previsto podés tener dos corriendo) y
**`startingDeadlineSeconds`** (si el cluster estuvo caído a las 3 AM, sin esto
la ejecución se pierde en silencio).

**Opción B — Scheduler externo + cola.** Mejor todavía si querés
paralelismo y reintentos por cliente:

```
EventBridge Scheduler (3 AM del día 1)
        │
        ▼
 Lambda / Job "planificador"  ──► publica N mensajes, uno por cliente
        │                          (SQS FIFO con MessageGroupId = clienteId,
        │                           o Kafka con key = clienteId)
        ▼
 Workers ya existentes  ──► consumen y facturan, idempotentemente
```

Por qué esto es lo mejor de todo, y es la parte que separa una respuesta
buena de una excelente: **separa "decidir qué facturar" de "facturar a un
cliente"**.

- El planificador es rápido y liviano: sólo emite mensajes.
- Cada cliente es una **unidad de trabajo independiente**, con su propio
  reintento. Si falla la factura del cliente 8.412, se reintenta **esa**, no
  las 200.000.
- Paralelizás gratis: 20 workers facturan 20 clientes a la vez.
- Y si algo falla definitivamente, queda en la **DLQ** con nombre y apellido,
  en vez de un `@Cron` que tiró una excepción a las 3:04 AM y nadie vio.

Compará con el original: un `@Cron` que procesa 200.000 clientes en un loop,
y si explota en el cliente 150.000 no sabés cuáles se facturaron.

**Opción C — Advisory lock de Postgres**, si querés algo intermedio sin tocar
infraestructura:

```ts
const [{ lock }] = await this.db.query(
  `SELECT pg_try_advisory_lock(hashtext('facturacion-mensual')) AS lock`,
);
if (!lock) return;
// ... el lock se libera SOLO cuando la sesión termina, incluso si el pod muere
```

Sigue siendo un lock, pero es estrictamente mejor que el de Redis: **no tiene
TTL que calibrar** (se libera cuando la conexión se cierra, y si el pod muere
Postgres lo detecta), vive en el mismo sistema transaccional que tus datos, y
no agrega una dependencia nueva. La contra: te ata a una conexión abierta
durante todo el job, y con PgBouncer en modo `transaction` hay que usar la
variante `_xact` o saltear el pooler.

### 1.5 La respuesta de una frase

> **"Primero hago que facturar dos veces sea imposible por diseño, con un
> `UNIQUE (cliente, periodo)`. Después saco el scheduler del proceso
> replicado: un `CronJob` de Kubernetes que emite un mensaje por cliente a una
> cola, y los workers facturan idempotentemente con reintentos individuales y
> DLQ. El lock no aparece por ningún lado — y si apareciera, sería un
> advisory lock de Postgres, no Redis."**

---

## 2. De 4 a 6 shards con `hash(tenant_id) % 4`

### 2.1 Cuántas claves se mueven

Con módulo, la clave se queda donde estaba sólo si `hash % 4 == hash % 6`.
Como `lcm(4, 6) = 12`, alcanza con mirar los 12 restos posibles:

| `hash % 12` | `% 4` | `% 6` | ¿se queda? |
| --- | --- | --- | --- |
| 0 | 0 | 0 | ✅ |
| 1 | 1 | 1 | ✅ |
| 2 | 2 | 2 | ✅ |
| 3 | 3 | 3 | ✅ |
| 4 | 0 | 4 | ❌ |
| 5 | 1 | 5 | ❌ |
| 6 | 2 | 0 | ❌ |
| 7 | 3 | 1 | ❌ |
| 8 | 0 | 2 | ❌ |
| 9 | 1 | 3 | ❌ |
| 10 | 2 | 4 | ❌ |
| 11 | 3 | 5 | ❌ |

**Se quedan 4 de 12 = 33%. Se mueve el 67%.** Dos tercios de tus datos
cambian de máquina para agregar un 50% de capacidad.

### 2.2 Con consistent hashing

El mínimo teórico que **tiene** que moverse es lo que termina en los nodos
nuevos: `2/6 = **33%**`. Un anillo con vnodos se pega bastante a ese número.

**67% contra 33%: la mitad del trabajo.** Pero el beneficio real no es ése.

### 2.3 Lo que de verdad cambia el problema: shards lógicos

Ninguna de las dos opciones anteriores es la que uno quiere. Lo que uno
quiere es **no rehashear nada**:

```
shard_lógico = hash(tenant_id) % 1024        <- FIJO, para siempre
shard_físico = tabla_de_ruteo[shard_lógico]  <- esto es lo que cambia
```

| | `% N` físico | Consistent hashing | Shards lógicos |
| --- | --- | --- | --- |
| Se mueve | 67% | 33% | 33% |
| Unidad de movimiento | Clave por clave | Clave por clave | **Shard lógico entero** |
| ¿Sabés qué se mueve? | Hay que calcularlo por clave | Idem | **Es una lista de 341 shards** |
| ¿Reversible a mitad? | No | No | **Sí: shard por shard** |

Con 1024 shards lógicos y 4 físicos, cada máquina tiene 256. Para pasar a 6,
movés **341 shards lógicos** (85 de cada nodo viejo) y actualizás la tabla de
ruteo. Cada movimiento es una unidad chica, verificable y reversible: si el
shard 517 falla a mitad, revertís **ese** y seguís.

Eso es lo que hacen Redis Cluster (16.384 *hash slots*), Vitess y Citus. Y es
la recomendación práctica más valiosa del módulo 03: **el día que shardees,
elegí muchos más shards lógicos de los que vas a necesitar.** Es gratis al
principio y te ahorra esta migración entera después.

### 2.4 La migración sin downtime

Es el *expand / migrate / contract* del módulo 02, aplicado a datos. Seis
fases, y entre fase y fase pasan días:

```
FASE 1 — PREPARAR
  Levantar los 2 shards nuevos, vacíos, mismo esquema.
  Desplegar la capa de ruteo con feature flags:
     escribirEnNuevo = false ; leerDeNuevo = false

FASE 2 — DOBLE ESCRITURA          escribirEnNuevo = true
  Toda escritura va al mapeo viejo Y al nuevo.
  Las lecturas siguen yendo al viejo.
  >>> Desde acá, nada de lo que llegue se pierde. Éste es exactamente
      el problema que resuelve la doble escritura: qué hacer con las
      escrituras que ocurren DURANTE la copia.

FASE 3 — BACKFILL
  Un copiador por lotes mueve lo histórico, con rate limiting para no
  matar la base (y en horario de baja carga).
  Escribe con "no pisar si ya existe algo más nuevo" (comparar
  updated_at), porque la doble escritura puede haber puesto ahí una
  versión más fresca que la del snapshot.

FASE 4 — VERIFICAR                <<< la fase que todos saltean
  Shadow reads: leer de los dos, comparar, registrar diferencias —
  SIN usar el resultado nuevo. Hasta que la tasa de diferencias sea
  cero durante varios días, no se avanza.
  También: contar filas por shard, checksums por rango.

FASE 5 — CAMBIAR LECTURAS         leerDeNuevo = true
  Por porcentaje de tráfico: 1% -> 10% -> 50% -> 100%, con capacidad
  de volver atrás en un segundo (es un flag, no un deploy).

FASE 6 — CONTRACT
  Apagar la doble escritura. Borrar los datos viejos (¡después de un
  backup, y con una semana de gracia!). Sacar el código del mapeo viejo.
```

**La regla que gobierna todo esto: en ningún momento puede existir un estado
del que no puedas volver.** Por eso las lecturas cambian al final y con flag,
y por eso el borrado es lo último.

**Alternativa a la doble escritura: CDC.** En vez de que la aplicación
escriba en los dos lados, tomás un snapshot y aplicás el stream de cambios
desde el LSN de ese snapshot con Debezium. Menos código en la aplicación,
más infraestructura. Es lo que conviene si ya tenés Debezium andando.

**Y con shards lógicos, todo esto se hace de a un shard.** La fase 2-6 aplica
a 1 de 1024 shards por vez: el radio de daño de un error es 0,1% de los
tenants en vez del 100%. Es tan distinto que casi no es la misma operación.

### 2.5 La pregunta que hay que hacer antes de todo esto

**¿Hace falta shardear, o hace falta un índice?** (Módulo 03, D2.) Antes de
una migración de dos trimestres: índices, PgBouncer, réplicas de lectura,
particionado por tiempo, archivado a S3, y escalar vertical. Shardear es la
última herramienta.

---

## 3. HPA por CPU al 70% en un servicio que espera al LLM

### 3.1 Qué pasa en un pico de tráfico

**Nada. Ése es el problema.**

Paso a paso:

1. El tráfico se duplica. Las requests entran y se quedan **esperando I/O**:
   el pod está bloqueado en un `await` de 6 segundos contra el proveedor del
   LLM.
2. **Esperar I/O no consume CPU.** La CPU sigue en 15-20%. El HPA mira su
   métrica, ve que está muy por debajo del 70%, y **no escala**. Desde el
   dashboard, el servicio parece ocioso.
3. Mientras tanto, por la Ley de Little: `L = λ × W`. Si `λ` pasa de 50 a 100
   req/s con `W` de 6 s, la concurrencia en vuelo pasa de 300 a **600
   requests simultáneas**, y sigue creciendo si el proveedor empieza a tardar
   más (que es lo que pasa cuando vos le mandás más carga).
4. Cada request en vuelo retiene un socket, un contexto de tracing, los
   buffers del prompt y la respuesta, y probablemente una conexión del pool
   de Postgres tomada antes de la llamada. **La memoria sube linealmente con
   el tiempo.**
5. El pool de conexiones se agota → **endpoints que no tienen nada que ver
   con el LLM empiezan a fallar**. El fallo se propagó por un recurso
   compartido.
6. El heap crece → el GC trabaja más → pausas más largas → **ahora sí sube la
   CPU**, pero por GC, no por trabajo útil. El HPA por fin escala... y los
   pods nuevos tardan 2-5 minutos en estar listos, cuando el daño ya está
   hecho.
7. Los clientes llegan a su timeout y **reintentan**, agregando carga nueva.
8. El `livenessProbe` no responde (event loop trabado) → **Kubernetes mata el
   pod** → sus 600 requests en vuelo se pierden → el tráfico va a los pods
   restantes, que caen más rápido. Cascada.

Resultado: **el servicio se cae con la CPU al 20%**, y el autoescalado nunca
hizo nada. El post-mortem dice "no entendemos, había recursos de sobra".

### 3.2 Qué métrica usar

En orden de calidad:

**1. Requests en vuelo por pod (concurrencia).** Es literalmente la `L` de la
Ley de Little: la medida directa de saturación de un servicio de I/O. Si sabés
que un pod maneja bien 200 llamadas concurrentes, escalás con objetivo 120-140.

```ts
// exponer como métrica de Prometheus, o como métrica custom de CloudWatch
const enVuelo = new Gauge({ name: 'llm_requests_in_flight' });
```

En AWS, el equivalente sin instrumentar nada es
**`ALBRequestCountPerTarget`** con *target tracking*. En Kubernetes, **KEDA**
con una métrica custom o de Prometheus.

**2. Profundidad de cola / consumer lag**, si el trabajo va por cola — que es
como **debería** estar hecho (módulo 01, C4). Es la mejor señal que existe:
mide directamente el desbalance entre lo que producís y lo que consumís, y es
*leading*, no *lagging*. `KEDA` escala por lag de Kafka o por
`ApproximateNumberOfMessagesVisible` de SQS de forma nativa.

**3. Latencia p99**, como señal secundaria. Reacciona tarde (cuando la
latencia subió, ya hay cola) pero atrapa causas que las otras dos no ven.

**Lo que hay que dejar de mirar:** CPU, como señal principal, en cualquier
servicio dominado por I/O. Sirve para servicios de cómputo (transcodificación,
compresión, criptografía), no para uno que espera.

### 3.3 Lo que casi nadie dice, y es lo más importante

**Escalar pods no aumenta tu cuota con el proveedor del LLM.**

Si tu límite es 10.000 tokens por minuto, tenés 10.000 tokens por minuto con
3 pods y con 300. Agregar pods en un pico **sólo consigue que más requests
choquen contra el rate limit al mismo tiempo**, y lo que antes era una cola
ordenada pasa a ser una tormenta de `429`s.

Por eso, en un sistema de agentes, **el cuello de botella real casi nunca es
tu cómputo: es la cuota del proveedor**. Y un cuello de botella externo no se
resuelve con autoescalado, se resuelve con:

- **Una cola con backpressure.** El pico se acumula en Kafka/SQS, donde es
  visible y medible (el *lag*), en vez de acumularse en la memoria de tus
  pods, donde es invisible hasta que se caen.
- **Un limitador de concurrencia** hacia el proveedor (un semáforo global en
  Redis), dimensionado con tu cuota real. Si tu cuota da para 150 llamadas
  concurrentes, **nunca** mandes 600: las 450 extra van a fallar con 429 y vas
  a pagar los reintentos.
- **Timeouts y deadlines** en cada llamada (módulo 02, A4): sin deadline, `W`
  no tiene techo y `L` tampoco.
- **Degradación**: en saturación, respondé "estamos con demora, te avisamos
  cuando esté" en vez de aceptar trabajo que no vas a poder hacer. Rechazar
  rápido es más sano que encolar infinito (módulo 01, sección 5).

### 3.4 Y el pico de 90 segundos

Aunque uses la métrica correcta, el autoescalado **no llega a tiempo para un
pico corto**:

```
detectar   (agregación de métricas)      30-60 s
decidir    (cooldown / stabilization)    15-60 s
arrancar   (pull de imagen + boot Node)  30-90 s
calentar   (JIT, pools, DNS)             10-30 s
                                        ─────────
                                         2 a 5 minutos
```

El pico de 90 segundos **terminó antes de que el pod nuevo reciba su primera
request**.

> **El autoescalado sirve para tendencias, no para picos.** Los picos se
> absorben con margen de capacidad (el 30-40% del módulo 01) o con una cola
> que los aplane.

Decir esto explícitamente en una entrevista vale mucho, porque la respuesta
refleja de casi todo el mundo es "lo resolvemos con autoscaling".

### 3.5 La respuesta de una frase

> **"No va a pasar nada: la CPU no sube porque esperar I/O no consume CPU, así
> que el HPA no escala mientras la concurrencia en vuelo crece hasta agotar
> memoria y el pool de conexiones. Escalaría por requests en vuelo por pod —
> que es la `L` de la Ley de Little — o directamente por lag de la cola. Pero
> el punto de fondo es que más pods no me dan más cuota con el proveedor del
> LLM: el pico se absorbe con una cola y un limitador de concurrencia, no con
> autoescalado."**

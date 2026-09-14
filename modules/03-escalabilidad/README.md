# Módulo 03 — Escalabilidad

## Por qué acá

Los módulos 01 y 02 dejaron dos conclusiones incómodas:

- Un servicio al 90% de utilización tiene **10x** la latencia de uno al 50%
  (módulo 01, sección 5).
- Cada dependencia síncrona **multiplica** tu disponibilidad hacia abajo
  (módulo 02).

La reacción instintiva a las dos es la misma: *"le pongo más máquinas"*. Este
módulo es sobre cuándo eso funciona, cuándo no cambia nada, y qué tiene que
ser cierto en tu código **antes** de que agregar máquinas sirva para algo.

Porque el problema real casi nunca es "no tengo suficientes réplicas". Es
que el sistema tiene algo que **no se puede replicar**.

## Teoría mínima

### 1. Vertical vs horizontal

| | Vertical (*scale up*) | Horizontal (*scale out*) |
| --- | --- | --- |
| Qué hacés | Una máquina más grande | Más máquinas iguales |
| Complejidad | **Cero.** Cambiás el tipo de instancia | Alta: estado, balanceo, coordinación |
| Límite | Físico y económico (el precio crece más rápido que la capacidad) | Prácticamente ninguno |
| Tolerancia a fallos | **Ninguna.** Esa máquina es un SPOF | Alta: se cae una, siguen las demás |
| Downtime al escalar | Sí, casi siempre | No |

El consejo que nadie da y que vale mucho decir en una entrevista:
**escalá vertical primero**. Una instancia de 64 vCPU cuesta muchísimo menos
—en dinero y sobre todo en tiempo de ingeniería— que rediseñar para
horizontal. Hoy una sola máquina maneja decenas de miles de requests por
segundo. La mayoría de los sistemas que "necesitan escalar" en realidad
necesitan **un índice**.

Pero hay un límite duro que no es de performance: **una sola máquina es un
punto único de falla**. Aunque te sobre capacidad, vas a querer al menos 2-3
réplicas por disponibilidad. Ese es el argumento honesto para horizontal, y
es de disponibilidad, no de throughput.

Y una asimetría clave: **lo que se escala horizontal con facilidad son los
servicios sin estado. La base de datos casi siempre se escala vertical
primero**, porque el estado es justamente lo que no se replica gratis
(módulo 05).

### 2. La precondición: *stateless*

Escalar horizontalmente sólo funciona si **cualquier request puede ir a
cualquier réplica**. Eso exige que el servicio no guarde nada en su propia
memoria o disco que otra réplica necesite.

Los cinco lugares donde el estado se esconde en un NestJS:

| Estado escondido | Qué se rompe con N réplicas | Dónde va |
| --- | --- | --- |
| Sesión en memoria | El usuario se "desloguea" al azar | Redis, o JWT sin estado |
| Caché en un `Map` del servicio | Cada pod tiene datos distintos; invalidar es imposible | Redis (módulo 04) |
| Archivos subidos en disco local | El pod que sirve la descarga no es el que la recibió | S3 |
| Conexiones WebSocket | El evento a emitir está en otro pod | Redis pub/sub |
| **`@Cron()` de `@nestjs/schedule`** | **Se ejecuta N veces, una por pod** | Ver abajo |

**El cron es el que más muerde** y casi nunca se piensa hasta que pasa. Un
`@Cron('0 3 * * *')` que manda el resumen diario, con 6 pods, manda **6
mails a cada usuario**. Con 6 pods y un job de facturación, factura 6 veces.

Las soluciones, de peor a mejor:

```ts
// ❌ Roto con N > 1
@Cron('0 3 * * *')
async enviarResumen() { ... }

// ⚠️ Funciona, pero es un lock: hay que pensar el TTL y qué pasa si el
//    pod muere con el lock tomado (módulo 06)
@Cron('0 3 * * *')
async enviarResumen() {
  const lock = await this.redis.set('cron:resumen', podId, 'NX', 'EX', 3600);
  if (!lock) return;               // otro pod se lo quedó
  await this.hacerElTrabajo();
}

// ✅ Mejor: el scheduler vive FUERA de la app
//    EventBridge / cron de k8s -> publica un evento -> lo consume UN worker
//    (la partición de Kafka o la visibility timeout de SQS garantizan uno solo)
```

El principio general, que reaparece todo el tiempo: **si algo tiene que pasar
exactamente una vez, no puede vivir en un proceso replicado**. O sale del
proceso, o necesita coordinación explícita.

### 3. Load balancing

**L4 vs L7** — la distinción del módulo 02 (el problema de gRPC), formalizada:

| | L4 (transporte) | L7 (aplicación) |
| --- | --- | --- |
| Qué ve | IP y puerto | La request HTTP completa |
| Qué balancea | **Conexiones** | **Requests** |
| Ejemplos AWS | NLB | ALB |
| Latencia | Menor | Un poco mayor |
| Puede | Muy alto throughput, TLS passthrough | Rutear por path/header, retries, gRPC |
| Problema | **Con conexiones persistentes (HTTP/2, gRPC, WebSocket) el reparto se pega** | — |

**Algoritmos**, de más simple a más útil:

- **Round robin**: uno a cada uno, por turno. Asume que todos los servidores
  son igual de rápidos y todas las requests cuestan lo mismo. **Casi nunca es
  cierto**: un pod recién arrancado tiene el JIT frío y los pools vacíos.
- **Least connections**: al que menos requests activas tenga. Se adapta solo a
  servidores lentos. Requiere que el balanceador lleve estado de todos.
- **Random**: sorprendentemente decente y sin estado, pero deja colas
  desbalanceadas.
- **Power of two choices**: elegí **dos al azar** y mandale al que tenga menos
  carga. Es casi tan bueno como *least connections* —y a veces mejor— pero
  **sin estado global**. La mejora sobre random puro es enorme y
  contraintuitiva: pasás de un desbalance que crece como `O(log n)` a uno que
  crece como `O(log log n)`.

Lo vas a medir en `balanceo.ts`.

**Health checks** — la parte que rompe producción:

- **Liveness**: ¿el proceso está vivo? Si falla, se reinicia el pod.
- **Readiness**: ¿puede recibir tráfico *ahora*? Si falla, se lo saca del
  balanceador **sin reiniciarlo**.

Confundirlos es un clásico: si tu *liveness* chequea la base de datos y la
base tiene un hipo, **Kubernetes reinicia todos tus pods a la vez** y
convertís una degradación en una caída total. Regla: *liveness* chequea sólo
el proceso; *readiness* chequea dependencias.

Y dos cosas que casi nadie configura:

- **Connection draining** (*deregistration delay*): al bajar un pod, dejar de
  mandarle tráfico nuevo pero **darle tiempo a terminar** lo que tiene en
  vuelo. Sin esto, cada deploy corta requests en el aire.
- **Slow start**: darle al pod nuevo tráfico creciente en vez de su cuota
  completa desde el segundo cero. Sin esto, el pod recién levantado —JIT
  frío, pools vacíos, cachés locales vacías— recibe su 1/N completo, responde
  lento, y su latencia contamina el p99 de todo el servicio en cada deploy.

**Sticky sessions**: atar un usuario a un pod. Funciona, y es **deuda
técnica**: rompe el balanceo, complica los deploys (¿qué pasa con las
sesiones del pod que baja?) y esconde el problema real, que es tener estado
en memoria. Úsalas como parche temporal, nunca como diseño.

### 4. Consistent hashing

**El problema.** Tenés N nodos y repartís las claves con `hash(key) % N`
(shards de base, nodos de caché, cualquier cosa particionada). Agregás un
nodo → `% 4` pasa a ser `% 5` → **se remapea cerca del 80% de las claves**.
Si eran claves de caché, todas se vuelven miss al mismo tiempo: **la base
recibe el 100% del tráfico de golpe** y te lleva puesto el sistema justo
mientras intentabas ampliarlo.

**La solución.** Mapeá nodos **y** claves al mismo anillo de 0 a 2³²; cada
clave va al primer nodo que encuentre girando en sentido horario. Al agregar
un nodo, **sólo se remapean las claves entre él y su predecesor**: `1/N` en
vez de `(N-1)/N`.

**Nodos virtuales.** Con pocos nodos reales el anillo queda desparejo (uno se
lleva el 40% y otro el 5%). Se resuelve poniendo cada nodo físico en ~150
posiciones distintas del anillo. Con eso el reparto queda dentro de unos
pocos puntos porcentuales del ideal.

Dónde aparece en la vida real: Redis Cluster (con hash slots, una variante),
DynamoDB, Cassandra, memcached con `ketama`, CDNs. Lo vas a medir en
`consistent-hashing.ts`.

### 5. Particionado (sharding)

Cuando el dato ya no entra en una máquina, hay que partirlo:

| Estrategia | Cómo | Ventaja | Problema |
| --- | --- | --- | --- |
| **Por rango** | A-M en shard 1, N-Z en shard 2 | Consultas por rango eficientes | **Hot spots**: si particionás por fecha, todas las escrituras van al shard de hoy |
| **Por hash** | `hash(user_id) % N` | Reparto parejo | Perdés consultas por rango; rebalancear es caro |
| **Por directorio** | Una tabla dice qué shard tiene cada clave | Flexible, rebalanceo fino | El directorio es un SPOF y un cuello de botella |
| **Geográfica** | Por región del usuario | Latencia, residencia de datos | Reparto desparejo por población |

Tres cosas que hay que decir en una entrevista sobre sharding:

1. **Elegir mal la clave de partición es la decisión más cara de revertir de
   todo el sistema.** Más que el lenguaje, más que el framework.
2. **Las hot partitions son el modo de falla típico.** Particionar por
   `tenant_id` es lógico hasta que un tenant es 100 veces más grande que los
   demás. Ahí hace falta una clave compuesta, o tratarlo aparte.
3. **Lo que se pierde:** joins entre shards, transacciones que cruzan shards,
   `COUNT(*)` global, unicidad global (necesitás IDs distribuidos: sección 6).

Y la regla de oro: **sharding es la última herramienta, no la primera.**
Antes van índices, réplicas de lectura, particionado por tiempo dentro de la
misma base, y archivado a S3.

### 6. IDs en un sistema distribuido

Si cada shard genera IDs, `AUTO_INCREMENT` deja de servir: dos shards
generarían el mismo ID. Las opciones:

| | Tamaño | Ordenable por tiempo | Coordinación | Localidad en índices |
| --- | --- | --- | --- | --- |
| **UUIDv4** (aleatorio) | 128 bits | ❌ No | Ninguna | **Pésima** |
| **UUIDv7 / ULID** | 128 bits | ✅ Sí (prefijo de timestamp) | Ninguna | **Buena** |
| **Snowflake** | 64 bits | ✅ Sí | Necesita un ID de máquina único | Buena |

**"Localidad en índices" es el punto que se subestima y el que más duele.**
Un índice B-tree guarda las claves ordenadas. Con **UUIDv4**, cada `INSERT`
cae en una página al azar del índice: el motor tiene que traer esa página del
disco, modificarla, y muy seguido **partirla en dos** (*page split*). Con
IDs ordenados por tiempo, todos los inserts caen en la **última** página —
que ya está en memoria — y el índice crece de forma compacta.

En tablas grandes esto es una diferencia de varias veces en throughput de
escritura y un índice bastante más chico. Lo vas a medir en
`ids-distribuidos.ts`.

Recomendación práctica: **UUIDv7 o ULID** por defecto. Tenés unicidad sin
coordinación, orden temporal gratis y buena localidad. UUIDv4 sólo cuando
necesites que el ID **no filtre información** (un ID secuencial le dice a un
competidor cuántas órdenes tenés por día).

### 7. Autoescalado

Escalar automáticamente parece la solución, y trae sus propios problemas:

- **Métrica.** La CPU es un mal proxy para un servicio de I/O como un NestJS
  que espera a la base y a un LLM: podés estar saturado con 20% de CPU. Mejor:
  **requests en vuelo por pod**, **profundidad de cola**, **consumer lag**, o
  latencia p99. En AWS: *target tracking* sobre `ALBRequestCountPerTarget`
  suele funcionar mucho mejor que sobre CPU.
- **Tiempo de reacción.** Detectar (30-60 s de métricas) + decidir (el
  cooldown) + arrancar el pod (imagen, boot de Node, warm-up) = **2 a 5
  minutos**. Un pico de tráfico de 90 segundos **termina antes de que llegue
  el pod nuevo**. El autoescalado sirve para tendencias, **no para picos**:
  los picos se absorben con margen de capacidad (el 30-40% del módulo 01) o
  con una cola.
- **Escalar hacia abajo es más peligroso que hacia arriba.** Bajar rápido
  después de un pico te deja sin margen para el siguiente. Configurá el
  *scale-in* mucho más lento que el *scale-out*.
- **Escalar no siempre ayuda.** Si el cuello de botella son las conexiones a
  Postgres, más pods = más conexiones = **la base peor** (módulo 01, C2). Si
  es una pausa de GC, cada pod nuevo trae su propio GC. **Antes de escalar,
  identificá el recurso saturado.**

### 8. Aplicado a tu stack

- **Node es un hilo.** Escalás por proceso: N pods × 1 hilo útil. Por eso las
  instancias con muchos núcleos se aprovechan con **varios pods chicos**, no
  con un pod grande (o con `cluster`/PM2, aunque en Kubernetes es mejor dejar
  que el orquestador lo maneje).
- **El techo real suele ser el pool de la base**, no los pods (módulo 01).
  Calculá con la Ley de Little antes de tocar el HPA, y poné PgBouncer.
- **Los consumers de Kafka NO escalan con réplicas** más allá del número de
  particiones. Es el error más frecuente y lo vemos a fondo en el módulo 07.
- **WebSockets/SSE**: la conexión vive en un pod. Para emitirle a un usuario
  desde otro pod necesitás un bus (Redis pub/sub). `@nestjs/websockets` tiene
  adaptadores de Redis justamente para esto.
- **gRPC en k8s**: repasá el módulo 02, sección 5. Es *la* razón por la que
  tus pods nuevos pueden quedar vacíos.

## Lo que vas a correr

```bash
node modules/03-escalabilidad/balanceo.ts
node modules/03-escalabilidad/consistent-hashing.ts
node modules/03-escalabilidad/ids-distribuidos.ts
```

1. **`balanceo.ts`** — simula 200.000 requests sobre 20 servidores de
   velocidad desigual con cinco algoritmos. Mirá el p99 de *round robin*
   contra *power of two choices*: es la diferencia entre un algoritmo que
   ignora la realidad y uno que la mide.
2. **`consistent-hashing.ts`** — mide qué porcentaje de claves se remapea al
   agregar un nodo, con hashing por módulo y con anillo. Después muestra por
   qué los nodos virtuales no son opcionales.
3. **`ids-distribuidos.ts`** — simula un índice B-tree y cuenta los *page
   splits* con UUIDv4 contra ULID. El número sorprende.

## Para pensar / próximo paso

- Tu servicio tiene un `@Cron()` que factura. Pasás de 1 a 4 pods. ¿Qué pasa
  el primer día de mes? Ahora resolvelo **sin** usar un lock de Redis.
- Tenés 4 shards por `hash(tenant_id) % 4` y necesitás pasar a 6. ¿Cuántas
  claves se mueven? ¿Y si hubieras usado consistent hashing? ¿Cómo hacés la
  migración **sin downtime**?
- Tu HPA escala por CPU al 70%. El servicio pasa el 90% del tiempo esperando
  respuestas de un LLM. ¿Qué va a pasar en un pico de tráfico? ¿Qué métrica
  usarías en su lugar?

Las tres están resueltas en [`para-pensar.md`](para-pensar.md).

## Fuentes

- **Mitzenmacher**, *The Power of Two Choices in Randomized Load Balancing*
  (1996) — el paper de la sección 3: <https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf>
- **Karger et al.**, *Consistent Hashing and Random Trees* (1997) — el
  original: <https://dl.acm.org/doi/10.1145/258533.258660>
- **Amazon**, *Dynamo: Amazon's Highly Available Key-value Store* (2007) —
  consistent hashing aplicado: <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **Marc Brooker**, *Load Balancing* y *Power of 2 Random Choices*:
  <https://brooker.co.za/blog/2012/01/17/two-random.html>
- **Kubernetes**, *Configure Liveness, Readiness and Startup Probes*:
  <https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/>
- **UUIDv7**, RFC 9562: <https://www.rfc-editor.org/rfc/rfc9562.html>

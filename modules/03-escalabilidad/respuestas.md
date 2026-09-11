# Respuestas modelo — Módulo 03

> Abrilo **después** de escribir las tuyas en `mis-respuestas/03.md`.

---

## Bloque A — Conceptos

### A1 — Vertical u horizontal

> **Vertical primero, horizontal cuando el límite deja de ser de capacidad y
> pasa a ser de disponibilidad.**

Escalar vertical es cambiar un tipo de instancia: cero complejidad, cero
rediseño, y hoy una sola máquina maneja decenas de miles de req/s. Escalar
horizontal exige que el servicio sea *stateless*, un balanceador, health
checks, y resolver coordinación (crons, locks, sesiones). **Es varios órdenes
de magnitud más caro en tiempo de ingeniería.**

Lo que hace que no sea obvio es que **son ejes distintos**:

- Vertical resuelve **capacidad**. Horizontal resuelve capacidad **y
  disponibilidad**.
- Una sola máquina, por grande que sea, es un **punto único de falla**. Ese
  —y no el throughput— es el argumento honesto para tener al menos 2-3
  réplicas desde el día 1.

Y hay una asimetría que conviene decir: **los servicios sin estado se escalan
horizontal con facilidad; las bases de datos se escalan vertical primero**,
porque el estado es exactamente lo que no se replica gratis.

Cierre que suma: *"Mi default es vertical + 2 o 3 réplicas por disponibilidad.
Paso a pensar en horizontal en serio cuando el costo de la instancia crece más
rápido que la capacidad que me da, o cuando ya no existe una instancia más
grande."*

### A2 — Stateless y los cinco escondites

*Stateless* = **cualquier request puede ir a cualquier réplica** y dar el
mismo resultado. El servicio no guarda en su memoria ni en su disco nada que
otra réplica necesite.

| Estado escondido | Qué se rompe | Adónde va |
| --- | --- | --- |
| Sesión en memoria | El usuario se desloguea al azar según a qué pod caiga | Redis, o JWT sin estado |
| Caché en un `Map` | Cada pod tiene datos distintos; invalidar es imposible | Redis (módulo 04) |
| Archivos subidos al disco local | El pod que sirve la descarga no es el que la recibió | S3 |
| Conexiones WebSocket | El pod que quiere emitir no tiene el socket | Redis pub/sub |
| **`@Cron()`** | **Se ejecuta N veces, una por pod** | Scheduler externo (C1) |

El sexto, que casi nadie nombra y suma mucho: **rate limiters o contadores en
memoria**. Un `Map<ip, contador>` con 10 pods deja pasar 10x el límite.

### A3 — Liveness vs readiness

- **Liveness**: *¿el proceso está vivo?* Si falla → **se reinicia el pod**.
- **Readiness**: *¿puede recibir tráfico ahora?* Si falla → **se lo saca del
  balanceador, sin reiniciarlo**.

**El incidente si el liveness chequea la base:** la base tiene un hipo de 30
segundos (un failover, un `VACUUM` pesado, un pico de conexiones). El liveness
falla **en todos los pods a la vez**, porque todos dependen de la misma base.
Kubernetes reinicia **toda la flota simultáneamente**. Ahora:

1. No hay ningún pod sirviendo tráfico: convertiste una degradación parcial en
   una **caída total**.
2. Al arrancar todos juntos, abren todas sus conexiones al mismo tiempo contra
   una base que ya estaba sufriendo → **la terminás de matar**.
3. El liveness vuelve a fallar → reinicio otra vez → **CrashLoopBackOff en
   cascada**, del que el sistema no sale solo aunque la base se recupere.

Es el mismo fallo metaestable del módulo 01, disparado por una config de tres
líneas. La regla: **liveness chequea sólo el proceso** (`return 'ok'` está
bien); **readiness chequea dependencias**.

### A4 — Draining y slow start

- **Connection draining** (*deregistration delay* en AWS): al bajar un pod,
  dejar de mandarle requests nuevas pero **darle N segundos para terminar las
  que tiene en vuelo**. Sin esto, **cada deploy corta requests en el aire**:
  el usuario ve un 502 y, si la operación no era idempotente, no sabés si se
  ejecutó. Se ve como "errores esporádicos que sólo pasan cuando deployamos".
  Requiere además que la app maneje `SIGTERM`: dejar de aceptar conexiones,
  terminar lo pendiente, y recién ahí salir.
- **Slow start**: darle al pod nuevo tráfico creciente en vez de su 1/N
  completo desde el primer segundo. Sin esto, el pod recién levantado —JIT
  frío, pool de conexiones vacío, cachés locales vacías— recibe su cuota
  completa, responde varias veces más lento, y **contamina el p99 de todo el
  servicio en cada deploy**. Es la causa más común de "el p99 se dispara 3
  minutos después de cada release y después se normaliza solo".

### A5 — Consistent hashing en 2 minutos

**El problema.** Repartís claves entre N nodos con `hash(key) % N`. Agregás o
perdés un nodo y el módulo cambia para casi todas las claves: **se remapea
entre el 75% y el 97%**. Si eran claves de caché, se vuelven miss todas
juntas y la base recibe el 100% del tráfico de golpe.

**La solución.** Imaginá un anillo de 0 a 2³². Hasheás los **nodos** al anillo
y hasheás las **claves** al mismo anillo. Cada clave pertenece al primer nodo
que encontrás girando en sentido horario. Al agregar un nodo, sólo se remapean
**las claves que caen entre él y su predecesor** — es decir `1/N`, que es el
mínimo teórico posible, porque el nodo nuevo tiene que quedarse con algo.

**Por qué hacen falta nodos virtuales.** Con pocos nodos reales las posiciones
en el anillo quedan desparejas: la simulación muestra que con 1 punto por nodo
**el más cargado recibe casi 12 veces lo del menos cargado**. Cada vnodo es
una muestra más: poniendo cada nodo físico en ~150 posiciones distintas, la
ley de los grandes números empareja el reparto. Además, cuando un nodo se cae,
sus claves se reparten entre **muchos** vecinos en lugar de caer todas sobre
uno solo, que es el segundo beneficio y el que menos se menciona.

Dónde vive: Dynamo, Cassandra, Riak, memcached con `ketama`, CDNs. Redis
Cluster usa una variante (16.384 *hash slots* fijos que se asignan a nodos),
que es la misma idea con un nivel de indirección — y es justo la respuesta de
B3(c).

### A6 — Sticky sessions

Funciona porque garantiza que el usuario vuelva siempre al mismo pod, así que
su estado en memoria lo sigue. Los tres costos:

1. **Rompe el balanceo.** La carga ya no se reparte por request sino por
   usuario. Un usuario pesado, o un reparto desafortunado, deja un pod al
   100% y otro al 20%, y ningún algoritmo puede corregirlo.
2. **Rompe los deploys.** Cuando baja el pod, **el estado de sus usuarios
   desaparece**. Se deslogean, pierden el carrito, se corta el WebSocket.
   Cada deploy es un incidente pequeño.
3. **Impide el autoescalado real.** Los pods nuevos sólo reciben usuarios
   *nuevos*; los existentes siguen pegados a los pods viejos. Escalás en un
   pico y la carga no se mueve — es el mismo síntoma que el problema de gRPC
   con balanceo L4 del módulo 02.

Y el costo de fondo: **esconde el problema real**, que es tener estado en
memoria. Mientras funcione, nadie lo saca, y la deuda crece.

> **Rúbrica bloque A**
> - **Mid:** define stateless y sabe que liveness/readiness son distintos.
> - **Senior:** explica el incidente concreto del liveness contra la base,
>   nombra el cron entre los escondites de estado, y explica los vnodos.
> - **Staff:** ve que vertical/horizontal son ejes distintos (capacidad vs
>   disponibilidad) y que sticky sessions rompe el autoescalado, no sólo el balanceo.

---

## Bloque B — Números y algoritmos

### B1 — 3 de 20 pods degradados, round robin

- **(a) 15%** (3 de 20). Round robin reparte parejo por definición.
- **(b)** Sea `C` la capacidad de un pod sano. Los degradados hacen `C/5`.
  Capacidad de la flota = `17C + 3×(C/5) = 17,6C`. Al 70%, llegan `12,32C`
  req/s, y round robin le da a cada pod `12,32C / 20 = 0,616C`.

  Un pod degradado puede con `0,2C`. Su utilización es **`0,616 / 0,2 = 3,08`,
  o sea 308%**. Con utilización mayor a 1, **la cola no se estabiliza: crece
  para siempre** (módulo 01, sección 5). En producción se ve como timeouts
  masivos en el 15% del tráfico, mientras los otros 17 pods están medio
  ociosos y ninguna métrica promedio lo muestra.

  Es una muerte por "justicia": repartir parejo entre desiguales **no es
  balancear**.
- **(c)** Con *power of two choices* el tráfico a los degradados cae a **~5%**
  (la simulación da 4,8%) y el p99 pasa de minutos a ~460 ms.

  **Por qué alcanza con dos muestras:** no necesitás encontrar el mínimo
  global — sólo necesitás **evitar el peor**. La probabilidad de que las dos
  muestras al azar caigan en pods cargados es baja, y cuando pasa, la carga de
  ese pod sube, lo que baja su probabilidad de ganar la próxima comparación.
  Es un lazo de realimentación negativa que se auto-corrige.

  El resultado formal: el desbalance máximo pasa de `O(log n)` con una muestra
  a **`O(log log n)` con dos**. Una segunda muestra compra casi todo el
  beneficio; la tercera casi no agrega nada. Por eso está implementado en
  Envoy, NGINX y HAProxy.

  Y el corolario para entrevistas: **el health check te dice "vivo/muerto",
  pero el balanceo necesita "rápido/lento"**. Un pod degradado pasa el health
  check. Son dos señales distintas.

### B2 — Se cae un nodo de caché

- **(a)** De `% 8` a `% 7`: se remapean `(N-1)/N ≈ **87,5%**` de las claves.
- **(b)** `40.000 × 0,875 = **35.000 req/s** contra la base`, además de los
  misses normales.
- **(c)** El tráfico normal a la base es `40.000 × 0,04 = 1.600 req/s`.
  **35.000 / 1.600 ≈ 22x.** De golpe, sin aviso.
- **(d)** Con consistent hashing sólo se remapean las claves del nodo caído:
  `1/8 = 12,5%` → `5.000 req/s` → **~3x el tráfico normal**.

  **¿Alcanza para estar tranquilo? No.** Tres motivos:
  1. 3x instantáneo sigue siendo un pico que la base tiene que aguantar.
  2. Los 7 nodos restantes ahora guardan las claves del caído: **necesitan
     memoria que quizás no tienen**, y empiezan a evictar, generando *más*
     misses.
  3. Si esos misses hacen la misma query pesada **al mismo tiempo**, tenés un
     *cache stampede*: 5.000 requests idénticas simultáneas contra la base
     (módulo 04).

  Por eso consistent hashing es **una** defensa, no la defensa. Va con TTL
  con jitter, *single-flight*, y capacidad de caché con margen.

### B3 — De 4 a 6 shards con módulo

- **(a)** Una clave se queda donde estaba sólo si `hash % 4 == hash % 6`. Como
  `lcm(4,6) = 12`, alcanza con mirar `hash % 12`: de los 12 restos, sólo
  0, 1, 2 y 3 cumplen. **Se quedan 4/12 = 33%; se mueve el 67%.**
- **(b) Migración sin downtime** — el patrón es siempre el mismo, y es el
  *expand / migrate / contract* del módulo 02 aplicado a datos:

  1. **Levantar los 2 shards nuevos**, vacíos, con el mismo esquema.
  2. **Doble escritura.** La app empieza a escribir con el mapeo viejo **y**
     con el nuevo. Las lecturas siguen yendo al viejo. Acá ya no se pierde
     nada de lo que llegue durante la copia.
  3. **Backfill** de lo histórico con un copiador por lotes, con rate limiting
     para no matar la base. **Las escrituras que llegan durante la copia ya
     están cubiertas por el paso 2** — ése es exactamente el problema que
     resuelve la doble escritura. (La alternativa es CDC con Debezium: copiás
     un snapshot y aplicás el stream de cambios desde el LSN del snapshot.)
  4. **Verificar.** *Shadow reads*: leés de los dos y comparás, registrando
     las diferencias sin usarlas. Hasta que la tasa de diferencias sea cero,
     no se avanza.
  5. **Cambiar las lecturas** al mapeo nuevo, con un feature flag y por
     porcentaje de tráfico. Con capacidad de volver atrás en un segundo.
  6. **Contract**: apagar la doble escritura, borrar los datos viejos.

  Entre paso y paso pasan días. La regla es que **en ningún momento exista un
  estado del que no puedas volver**.
- **(c) Qué hacer el día 1:** no repartir por `% N_físico`, sino usar un
  nivel de indirección — **muchos shards lógicos, pocos físicos**:

  ```
  shard_lógico  = hash(tenant_id) % 1024      <- FIJO PARA SIEMPRE
  shard_físico  = tabla_de_ruteo[shard_lógico] <- cambia cuando querés
  ```

  Rebalancear pasa a ser *mover shards lógicos enteros* entre máquinas, sin
  rehashear una sola clave. De 4 a 6 nodos = mover 1024/4 − 1024/6 ≈ 85 shards
  lógicos de cada nodo viejo. Es exactamente lo que hacen Redis Cluster (16.384
  hash slots), Vitess y Citus.

  **Si tuviera que dar una sola recomendación práctica de todo este módulo,
  sería ésta:** el día que shardees, elegí muchos más shards lógicos de los
  que vas a necesitar. Es gratis al principio y te ahorra la migración
  completa después.

### B4 — `INSERT` de 2 ms a 45 ms con PK UUIDv4

- **(a) El mecanismo.** El índice B-tree de la PK guarda las claves
  **ordenadas**. Un UUIDv4 es aleatorio, así que cada `INSERT` cae en una
  página **al azar** de todo el índice. Mientras el índice entraba en el
  `shared_buffers` / buffer pool, esa página estaba en RAM y el insert costaba
  microsegundos. Cuando el índice superó la memoria disponible, **cada insert
  pasó a requerir una lectura aleatoria de disco** para traer la página, y
  después una escritura. A eso se suman los *page splits* 50/50, que dejan las
  páginas al ~70% de llenado e inflan todavía más el índice (la simulación da
  71% contra 90%).
- **(b) Por qué gradual.** Porque lo que se degrada es la **tasa de aciertos
  de la caché de páginas del índice**, y eso baja de forma continua a medida
  que el índice crece contra una memoria fija. No hay un evento: hay una curva.
  Por eso no se detecta en desarrollo, ni en staging, ni el primer año.
- **(c) Cómo confirmarlo antes de tocar nada:**
  - Tamaño del índice contra `shared_buffers`:
    `SELECT pg_size_pretty(pg_relation_size('events_pkey'));`
  - Tasa de aciertos del índice: `pg_statio_user_indexes`
    (`idx_blks_hit / (idx_blks_hit + idx_blks_read)`). Si viene cayendo, es esto.
  - Bloat y llenado: `pgstatindex('events_pkey')` → `avg_leaf_density`. Si
    ronda 65-70% en vez de ~90%, son los splits aleatorios.
  - Y el contraste que cierra el caso: un `INSERT` en una tabla nueva y chica
    con la misma estructura debería seguir tardando 2 ms.
- **(d) Qué hacer**, de menos a más invasivo:
  1. **Particionar por tiempo** (`pg_partman`, `PARTITION BY RANGE (created_at)`).
     El índice de la partición activa vuelve a ser chico y a entrar en RAM.
     **Suele ser el mejor retorno**: no toca la PK, no reescribe 800M filas, y
     además te resuelve el archivado.
  2. **Más RAM** (vertical). Es un parche que compra tiempo, y a veces es la
     decisión correcta mientras preparás lo otro.
  3. **Cambiar la PK a UUIDv7/ULID.** En 800M filas esto **no** es un
     `ALTER TABLE`: es tabla nueva + backfill + doble escritura + swap, o sea
     el procedimiento de B3(b) completo, con semanas de trabajo. Sólo si
     1 y 2 no alcanzan.

  Lo que **no** hay que hacer: un `REINDEX` y declarar victoria. Baja el bloat
  un rato y el problema vuelve, porque la causa es el patrón de acceso, no la
  fragmentación.

### B5 — HPA por CPU en un servicio que espera al LLM

- **(a)** La CPU **no sube**, porque esperar I/O no consume CPU. El HPA no
  escala. Mientras tanto las requests se acumulan: por Little, si `λ` sube y
  `W` es de 6 segundos, la concurrencia en vuelo explota. Cada request en
  vuelo retiene memoria, un socket y quizás una conexión del pool. El servicio
  se degrada y eventualmente se cae **con la CPU al 20%**, mientras el
  autoescalado mira para otro lado.
- **(b) Métricas mejores**, en orden:
  - **Requests en vuelo por pod** (o `ALBRequestCountPerTarget` en AWS): es
    directamente la `L` de la Ley de Little, o sea la medida real de
    saturación de un servicio de I/O.
  - **Profundidad de cola / consumer lag**, si el trabajo va por cola. Es la
    mejor señal que existe: mide el desbalance entre producción y consumo.
  - **Latencia p99**, como señal secundaria (reacciona tarde, pero atrapa
    causas que las otras no ven).
- **(c) Para un pico de 90 segundos, el autoescalado no sirve.** El tiempo de
  reacción es: detectar (30-60 s de agregación de métricas) + decidir
  (cooldown del HPA) + arrancar (pull de imagen, boot de Node, warm-up) =
  **2 a 5 minutos**. El pico termina antes de que el pod nuevo reciba su
  primera request.

  **El autoescalado sirve para tendencias, no para picos.** Los picos se
  absorben con margen de capacidad (el 30-40% del módulo 01) o con una cola
  que los aplane. Decir esto explícitamente en una entrevista vale mucho,
  porque la respuesta refleja es "lo resolvemos con autoscaling".

> **Rúbrica bloque B**
> - **Mid:** calcula bien los porcentajes de remapeo y sabe qué es un HPA.
> - **Senior:** ve que la utilización del pod degradado pasa de 1 (cola
>   infinita), diseña la migración con doble escritura, y sabe que la CPU no
>   mide saturación de I/O.
> - **Staff:** propone shards lógicos con tabla de ruteo, elige particionar por
>   tiempo antes que cambiar la PK, y dice que el autoescalado no sirve para picos.

---

## Bloque C — Aplicado a tu stack

### C1 — El `@Cron()` que factura

**(a)** Los 4 pods tienen el mismo `@Cron` registrado. A las 3 AM del día 1,
**los 4 arrancan la facturación**. En el mejor caso hay un `UNIQUE` que hace
fallar a tres de ellos con errores raros en los logs. En el peor, **facturás
cuatro veces a cada cliente**. Es un incidente con consecuencias legales y
contables, no un bug técnico.

**(b) Con lock de Redis:**

```ts
@Cron('0 3 1 * *')
async facturarTodos() {
  const token = randomUUID();
  const lock = await this.redis.set('cron:facturacion', token, 'NX', 'EX', 3600);
  if (!lock) return;                       // otro pod se lo quedó

  try {
    await this.facturar();                 // ¿y si tarda 2 horas?
  } finally {
    // Liberar SÓLO si el lock sigue siendo nuestro (Lua para que sea atómico)
    await this.redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1, 'cron:facturacion', token,
    );
  }
}
```

**Qué falla en mi propia solución** (esto es lo que evalúan de verdad):

1. **Si el trabajo tarda más que el TTL**, el lock expira **mientras el pod
   sigue facturando**. Otro pod lo toma y **arranca una segunda facturación en
   paralelo**. El `finally` con Lua evita borrar el lock ajeno, pero no evita
   la doble ejecución. La solución real necesita renovar el lock
   periódicamente (*lease*) y, sobre todo, un **fencing token**: el trabajo
   lleva un número creciente y el receptor rechaza los tokens viejos
   (módulo 06).
2. **Si el pod muere con el lock tomado**, nadie factura hasta que expire el
   TTL — y como el cron es mensual, **nadie factura este mes**. Un lock
   protege de la doble ejecución y **crea** el riesgo de la cero ejecución.
3. **Sin idempotencia en la facturación misma**, cualquier reintento duplica.
   El lock reduce la probabilidad; no la elimina. La garantía real tiene que
   estar en la operación: `UNIQUE (cliente_id, periodo)`.
4. Depende de que Redis esté vivo y de que su `SET NX` sea confiable. Con
   Redis en réplica y un failover, **dos pods pueden obtener el mismo lock**:
   es la crítica clásica a Redlock (módulo 06).

**(c) Sin lock — y por qué es mejor:**

```
EventBridge / CronJob de k8s  ──►  evento "facturacion.mensual.2026-10"
                                          │
                                          ▼
                                    SQS FIFO / topic de Kafka
                                          │
                                          ▼
                                  UN worker lo consume
```

El scheduler **sale del proceso replicado**. Quien garantiza "una sola
ejecución" pasa a ser la infraestructura: una `CronJob` de Kubernetes crea
**un Job con un pod**; una cola FIFO con deduplicación entrega el mensaje a
**un consumidor**.

Por qué es mejor, punto por punto:

- **Eliminás la clase entera de problemas**, no la mitigás. No hay TTL que
  calibrar ni fencing token que implementar.
- **Ganás reintentos, DLQ y observabilidad gratis.** Si el job falla, el
  mensaje vuelve a la cola. Con el `@Cron`, si falla a las 3 AM, te enterás el
  día 3 por un cliente.
- **El job puede tardar lo que quiera** sin que nadie le expire nada.
- **Es visible.** Ves el evento, ves el consumo, ves el resultado. Un `@Cron`
  adentro de un pod es una caja negra.

El principio general: **si algo tiene que pasar exactamente una vez, no puede
vivir en un proceso replicado.** O sale del proceso, o necesita coordinación
explícita — y la coordinación explícita es cara y sutil.

(Y aun así: la facturación tiene que ser idempotente. Siempre.)

### C2 — WebSockets en un `Map`

**(a)** El `Map` vive en la memoria **de un proceso**. El pod 3 busca el
socket del usuario, no lo encuentra, y **el evento se descarta en silencio**.
No hay error, no hay log, no hay excepción: simplemente el usuario nunca
recibe la notificación. Y funciona perfecto en desarrollo con un solo pod, lo
que hace que se detecte tarde y mal.

**(b) Dos soluciones:**

1. **Bus de mensajes entre pods** (`@socket.io/redis-adapter`, o Redis pub/sub
   a mano). Cada pod publica en un canal y todos los pods están suscritos; el
   que tiene el socket lo entrega.
   *Costo:* un salto de red más por emisión; entrega **at-most-once** (si el
   usuario está desconectado justo en ese instante, el mensaje se pierde — si
   no puede perderse, hace falta persistirlo y reenviarlo al reconectar); y
   Redis pasa a ser una dependencia crítica del tiempo real.
2. **Sticky sessions** por `user_id` en el balanceador.
   *Costo:* todo lo de A6. Y el problema de fondo no se resuelve: el estado
   sigue en memoria y sigue perdiéndose en cada deploy.

Tercera, para escalas grandes: **una capa de gateway dedicada** que sólo
mantiene conexiones (y se deploya poco), separada de los servicios de negocio
(que se deployan seguido). Así un release de la lógica no corta las
conexiones de nadie. Es lo que hacen los sistemas de chat en serio, y
nombrarlo muestra que pensaste en el ciclo de vida del deploy.

### C3 — 12 réplicas y el lag no baja

**Porque el paralelismo de un consumer group está limitado por el número de
particiones del topic, no por el número de réplicas.** Cada partición la
consume **exactamente un** consumer del grupo. Si el topic tiene 3
particiones, sólo 3 de tus 12 pods reciben mensajes: **los otros 9 están
vivos, sanos, consumiendo CPU y memoria, y sin hacer absolutamente nada.**

**La primera pregunta: "¿cuántas particiones tiene el topic?"**

Y la segunda, casi tan importante: *"¿el lag crece en todas las particiones o
en una sola?"*. Si crece en una sola, no es un problema de escala: es una
**partición caliente** por una mala elección de clave (por ejemplo, todos los
eventos de un tenant enorme con `key = tenantId`). Agregar particiones no
arregla eso — hay que cambiar la clave.

Módulo 07 completo.

### C4 — Qué ID para una tabla nueva

**ULID o UUIDv7.** Las cuatro razones, contra cada alternativa:

- **Contra `BIGSERIAL`**: no podés generar el ID **antes** de escribir, y eso
  lo necesitás para la clave de idempotencia, para devolver el ID en un 202
  antes de procesar, y para escribir padre e hijos en un solo viaje. Además
  filtra el volumen del negocio y se rompe el día que shardeás.
- **Contra `UUIDv4`**: la localidad en el índice. Misma unicidad, mismos 128
  bits, pero 24x el *working set* de escritura y 28% más de índice en disco
  (según la simulación). Es todo costo sin ningún beneficio, salvo el
  siguiente punto.
- **Contra `Snowflake`**: Snowflake es mejor —64 bits, la mitad de índice—
  pero necesita asignarle un `machine_id` **único** a cada proceso. En un
  autoscaling donde los pods van y vienen, eso es un servicio de coordinación
  más (ZooKeeper, o un rango por task de ECS). No vale la pena hasta escalas
  muy grandes.
- **A favor de ULID/UUIDv7**: único sin coordinación, ordenado por tiempo,
  buena localidad, y podés inferir *cuándo* se creó la fila con sólo mirar el
  ID — que es sorprendentemente útil en debugging.

**Cuándo cambiaría de opinión:** si el ID va a ser **público** (en una URL,
en una API hacia afuera). Un ID ordenado por tiempo permite **enumerar**
recursos y le dice a un competidor cuántas órdenes procesás por hora. Ahí:
UUIDv4 público + ULID interno, o un ID público opaco (un hash con sal, o un
`nanoid`) separado de la PK.

50.000 inserts/día son 0,6/s: a esa escala **cualquier opción funciona los
primeros años**. La decisión importa porque **la PK es lo más caro de cambiar
después** (ver B4).

> **Rúbrica bloque C**
> - **Mid:** ve el problema del cron duplicado y propone el lock de Redis.
> - **Senior:** critica su propio lock (TTL vs duración del trabajo, pod que
>   muere), sabe que las particiones limitan el consumer, y elige ULID con criterio.
> - **Staff:** saca el scheduler del proceso, separa la capa de gateway de
>   WebSockets, y ve el caso del ID público.

---

## Bloque D — Diseño abierto

### D1 — Rate limiter distribuido

**Dónde vive el contador.** En Redis, y no hay muchas alternativas: 50 pods
necesitan una vista compartida. Un contador local por pod deja pasar 50x el
límite (es el sexto escondite de estado de A2).

**El race condition.** La versión ingenua está rota:

```ts
// ❌ read-modify-write: dos pods leen 999 y los dos dejan pasar
const actual = await redis.get(key);
if (actual >= LIMITE) throw new TooManyRequests();
await redis.set(key, actual + 1);
```

Se resuelve con **una sola operación atómica**. `INCR` lo es, pero necesitás
el `EXPIRE` junto — y esos son dos comandos. La forma correcta es un script
Lua, que Redis ejecuta de forma atómica:

```lua
local actual = redis.call('INCR', KEYS[1])
if actual == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return actual
```

(Sin ese `if`, una clave que nunca llega a expirar se convierte en una fuga de
memoria en Redis.)

**Los algoritmos:**

| | Cómo | Pro | Contra |
| --- | --- | --- | --- |
| **Ventana fija** | Contador por minuto | Trivial, 1 sola clave | **Ráfaga de 2x en el borde**: 1.000 req a las 10:00:59 y 1.000 a las 10:01:00 = 2.000 en un segundo |
| **Ventana deslizante (log)** | Timestamp de cada request en un sorted set | Exacto | Memoria proporcional al límite; caro con límites altos |
| **Ventana deslizante (contador)** | Pondera la ventana anterior y la actual | Muy buena aproximación, 2 claves | Aproximado (error de ~1%) |
| **Token bucket** | Tokens que se reponen a tasa fija | **Permite ráfagas controladas**, que suele ser lo que el negocio quiere | Dos valores (tokens + último refill) |

**Mi elección: token bucket.** Un límite de "1.000 por minuto" casi nunca
significa "nunca más de 16,6 por segundo": significa "en promedio 1.000, y una
ráfaga corta está bien". El token bucket modela eso naturalmente, con dos
parámetros que el negocio entiende (tasa y tamaño de ráfaga). Si lo que se
busca es protección estricta de un recurso, ventana deslizante por contador.

**Si se cae Redis: *fail open*.** Para un rate limiter de uso legítimo, la
disponibilidad vale más que la exactitud: bloquear el 100% del tráfico porque
se cayó el contador convierte una caída de Redis en una caída total del
producto. **Pero *fail open* a secas es peligroso** si el limiter también te
protege de abuso. El diseño maduro es **degradar, no apagar**: cada pod cae a
un limiter local con `límite / 50` (su porción justa). Es aproximado y
conservador, pero no deja la puerta abierta.

Y hay que decir en voz alta cuál es el riesgo elegido: *"elijo fail-open
porque el costo de rechazar tráfico legítimo es mayor que el de dejar pasar
algo de exceso durante unos minutos. Si esto fuera protección anti-fraude, la
decisión sería la contraria."*

**Latencia:** +1 RTT a Redis (~0,5-1 ms en la misma AZ) en **cada** request.
A 100.000 req/s son 100.000 operaciones/s contra Redis, que un nodo aguanta
pero ya no es despreciable. Cómo evitarlo:

- **Token buckets locales con sincronización periódica.** Cada pod se
  "reserva" una porción del presupuesto (`1.000/50 = 20 por minuto`) y lo
  gasta sin red. Cada pocos segundos reconcilia contra Redis y le devuelve o
  le pide más. **Costo: es aproximado** — un usuario podría pasarse un poco si
  su tráfico cae desparejo entre pods. Es lo que hacen los rate limiters de
  alto volumen de verdad, y el trade-off (exactitud por latencia y por carga)
  hay que nombrarlo.
- **Pipelining** de la verificación con otra llamada a Redis que ya hicieras.

**Cierre que suma:** *"¿el límite es por API key, por IP, por usuario o por
endpoint? ¿Y qué devuelvo, 429 con `Retry-After`? Porque si no mando
`Retry-After`, el cliente reintenta inmediatamente y el rate limiter se
convierte en un amplificador de carga."* Esa última observación es de las que
más impresionan y casi nadie la hace.

### D2 — "¿Cuándo hay que shardear?"

La respuesta corta, y conviene arrancar por ahí: **"todavía no, y te digo qué
mido para saber cuándo."** Una instancia de 16 vCPU al 45% con 200.000
usuarios no está ni cerca. Shardear ahora sería la decisión de arquitectura
más cara y menos justificada posible.

**Qué mido** (y qué alerta pondría desde hoy):

1. **Tasa de aciertos del buffer pool** (`pg_statio_user_tables`). Es **el**
   indicador temprano: mientras el *working set* entre en RAM, todo vuela. Es
   lo primero que se degrada y lo último que la gente mira.
2. **Throughput de escritura del primario.** Es lo único que las réplicas
   **no** pueden ayudar a escalar, y por lo tanto es el verdadero motivo para
   shardear.
3. **p99 por tipo de query**, no global. Una query que se degrada suele ser un
   índice que falta, no una falta de escala.
4. **Tamaño de las tablas e índices más grandes** contra la RAM de la
   instancia. Ése es el número que predice B4.
5. **Duración de las operaciones de mantenimiento**: `VACUUM`, backups,
   `CREATE INDEX`. Es el límite operativo que llega antes de lo que uno cree.
6. **Tamaño de la instancia más grande disponible.** Saber cuánto techo te
   queda **en meses** es lo que convierte esto en una conversación de
   planificación en vez de una emergencia.

**Qué hago antes de shardear** (en orden, cada uno es 10x más barato que el
siguiente):

1. **Índices y queries.** El 80% de los "necesitamos escalar" son un índice
   faltante o un N+1. Es horas de trabajo, no meses.
2. **Pooling de conexiones (PgBouncer).** Módulo 01, C2.
3. **Caché** para lo caliente (módulo 04).
4. **Réplicas de lectura**, si el ratio lectura/escritura lo justifica. Ojo con
   el *replication lag* (módulo 05).
5. **Particionado por tiempo dentro de la misma base.** Da casi todo el
   beneficio del sharding para tablas de eventos, con una fracción de la
   complejidad, y sin tocar la aplicación.
6. **Archivar lo frío a S3.** Casi siempre el 90% de los datos no se consulta
   nunca.
7. **Escalar vertical.** Duplicar la instancia es una tarde de trabajo.

**La señal concreta que me haría decir "ahora sí":**

> **Cuando el throughput de ESCRITURA del primario sea el cuello de botella, y
> ya no exista una instancia más grande que comprar.**

Porque las escrituras son lo único que no se resuelve con réplicas, ni con
caché, ni con particionado local. Las señales de apoyo: el *working set* ya no
entra en la RAM de la instancia más grande disponible; o el `VACUUM`/backup ya
no entra en la ventana de mantenimiento.

**Y la parte política, que es la mitad de la respuesta:** al CTO le digo
*"shardear nos cuesta del orden de dos trimestres de trabajo y nos hace perder
joins, transacciones que crucen shards y `COUNT(*)` global para siempre. Con
el crecimiento actual del 20% mensual, proyecto que el límite llega en N
meses; pongamos hoy las alertas sobre estas 6 métricas y revisemos el número
cada trimestre."* Eso es planificar. Decir "sí, shardeemos" o "no hace falta"
sin un número es opinar.

> **Rúbrica bloque D**
> - **Mid:** pone el contador en Redis y sabe que hay que usar INCR.
> - **Senior:** usa Lua por atomicidad, compara los cuatro algoritmos, decide
>   fail-open explicitando el riesgo, y lista lo que hay que hacer antes de shardear.
> - **Staff:** propone buckets locales con reconciliación (y nombra el
>   trade-off), menciona `Retry-After` como amplificador de carga, y convierte
>   la pregunta del CTO en un plan con métricas y proyección.

---

## Fuentes para profundizar

- **Mitzenmacher**, *The Power of Two Choices in Randomized Load Balancing*:
  <https://www.eecs.harvard.edu/~michaelm/postscripts/handbook2001.pdf>
- **Marc Brooker**, *Power of 2 Random Choices*:
  <https://brooker.co.za/blog/2012/01/17/two-random.html>
- **Amazon**, *Dynamo* (2007) — consistent hashing y vnodos en producción:
  <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **Redis**, *Cluster specification* (los 16.384 hash slots = shards lógicos):
  <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>
- **Stripe**, *Scaling your API with rate limiters*:
  <https://stripe.com/blog/rate-limiters>
- **Kubernetes**, *Probes*:
  <https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/>
- **RFC 9562** (UUIDv7): <https://www.rfc-editor.org/rfc/rfc9562.html>
- **Postgres**, `pg_partman` para particionado por tiempo:
  <https://github.com/pgpartman/pg_partman>

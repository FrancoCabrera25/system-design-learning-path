# Módulo 05 — Bases de datos

## Por qué acá

Los cuatro módulos anteriores terminaron empujando trabajo hacia el mismo
lugar. El caché protege **a la base**. El sharding parte **a la base**. El
outbox escribe **en la base**. Y cada vez que algo se rompía, el diagnóstico
terminaba en una frase parecida: *"el pool se agotó"*, *"la query no usaba el
índice"*, *"el working set no entra en RAM"*.

Este módulo es esa caja negra. Y es el módulo donde más se nota la
diferencia entre alguien que usa un ORM y alguien que entiende qué pasa
debajo — que es, casualmente, lo que más se pregunta en un deep dive.

## Material de este módulo

| Archivo | Qué es |
| --- | --- |
| Este `README.md` | La teoría |
| [`quiz.md`](quiz.md) · [`respuestas.md`](respuestas.md) | Preguntas de entrevista y respuestas modelo con rúbrica |
| `indices.ts` · `aislamiento.ts` · `replication-lag.ts` | Los ejemplos ejecutables |

## Teoría mínima

### 1. Elegir el motor (la parte aburrida y la respuesta honesta)

| Familia | Ejemplos | Buena para | El costo |
| --- | --- | --- | --- |
| **Relacional** | Postgres, MySQL | Datos con relaciones, transacciones, consultas variadas | Escalar escrituras exige sharding |
| **Documento** | MongoDB, DynamoDB | Documentos autocontenidos, esquema flexible | Los joins los hacés vos, en la app |
| **Clave-valor** | Redis, DynamoDB | Lectura por clave, latencia mínima | Sólo sabés buscar por la clave |
| **Columnar** | ClickHouse, Redshift | Agregaciones sobre miles de millones de filas | Pésimo para leer/escribir una fila |
| **Series de tiempo** | Timescale, Prometheus | Métricas, retención por resolución | De nicho |
| **Grafo** | Neo4j | Recorridos de N saltos (amigos de amigos) | De nicho, y Postgres llega bastante lejos con CTEs recursivas |

La respuesta honesta, que conviene decir tal cual en una entrevista:

> **Postgres hasta que un requisito concreto te obligue a otra cosa.** Hace
> JSONB (documentos), búsqueda full-text, geoespacial con PostGIS, colas con
> `SKIP LOCKED`, y particionado nativo. La mayoría de los sistemas que
> "necesitan NoSQL" necesitan un índice.

Lo que **sí** justifica salir de Postgres: escrituras que ningún primario
aguanta (DynamoDB, Cassandra), analítica sobre miles de millones de filas
(ClickHouse), o latencia sub-milisegundo por clave (Redis).

Y el criterio que ordena la elección mejor que la familia: **¿cuáles son tus
patrones de acceso?** En un relacional podés no saberlo de antemano y
resolverlo después con un índice. En DynamoDB, el patrón de acceso **define
el esquema** — y si aparece uno nuevo, rediseñás. Esa es la diferencia real,
no "SQL vs NoSQL".

### 2. Índices: cómo funcionan y por qué uno de más te puede arruinar

Un índice B-tree guarda las claves **ordenadas** en páginas de ~8 KB, en un
árbol de 3-4 niveles. Buscar es bajar el árbol: `O(log n)`. Para 100 millones
de filas son ~4 lecturas en vez de 100 millones.

**Los cuatro tipos de acceso** que vas a ver en un `EXPLAIN`:

| Plan | Qué hace | Cuándo es correcto |
| --- | --- | --- |
| `Seq Scan` | Lee toda la tabla | Tabla chica, o la query trae >5-10% de las filas |
| `Index Scan` | Baja el árbol y va a buscar la fila a la tabla (*heap*) | Pocas filas |
| `Index Only Scan` | **No toca la tabla**: todo lo que pedís está en el índice | El ideal |
| `Bitmap Heap Scan` | Junta muchas posiciones y lee la tabla en orden físico | Cantidad media de filas |

**Selectividad: por qué un índice puede no usarse.** Si `estado = 'ACTIVO'`
matchea el 90% de las filas, usar el índice es **más lento** que leer la
tabla entera: por cada entrada del índice hay que hacer un salto aleatorio al
heap. El planner lo sabe y lo ignora — y hace bien. Un índice sobre una
columna de baja cardinalidad (`estado`, `tipo`, un booleano) es, casi
siempre, un índice que no se va a usar.

**Índice compuesto: el orden de las columnas es todo.** Con
`INDEX (tenant_id, created_at)`:

```sql
WHERE tenant_id = 5 AND created_at > '2026-01-01'   ✅ usa el índice completo
WHERE tenant_id = 5                                  ✅ usa el prefijo
WHERE created_at > '2026-01-01'                      ❌ NO lo usa
```

Es una guía telefónica ordenada por (apellido, nombre): buscar "todos los
Juan" no se beneficia en nada. **Regla: igualdad primero, rango después.**

**Índice parcial** — el que más rinde y menos se usa:

```sql
CREATE INDEX ON outbox (id) WHERE published_at IS NULL;
```

Sólo indexa las filas que cumplen. Es lo que hace que el publisher del outbox
(módulo 02) no escale con el tamaño histórico de la tabla.

**Y ahora la pregunta trampa: ¿por qué agregar un índice puede hacer más
lenta tu app?**

1. **Cada `INSERT`/`UPDATE`/`DELETE` actualiza TODOS los índices de la tabla.**
   Con 8 índices, un insert son 9 escrituras. Es la razón número uno.
2. **Ocupan RAM.** Un índice grande compite con los datos por el buffer pool.
   Un índice que no se usa **desaloja** páginas que sí se usaban.
3. **Confunden al planner.** Con muchos índices parecidos, a veces elige mal.
4. **Bloquean al crearlos** si no usás `CREATE INDEX CONCURRENTLY`.

Lo medís en `indices.ts`.

### 3. Transacciones, aislamiento y las anomalías

**ACID**: Atomicidad (todo o nada), Consistencia (se respetan las
restricciones), **Aislamiento** (las transacciones concurrentes no se pisan),
Durabilidad (lo commiteado sobrevive a un corte).

La "I" es la que tiene grados, y la que produce bugs:

| Nivel | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew |
| --- | --- | --- | --- | --- | --- |
| `READ UNCOMMITTED` | ✅ ocurre | ✅ | ✅ | ✅ | ✅ |
| **`READ COMMITTED`** ← *default de Postgres* | ❌ | ✅ **ocurre** | ✅ **ocurre** | ✅ **ocurre** | ✅ **ocurre** |
| `REPEATABLE READ` | ❌ | ❌ | ❌ (en PG) | ❌ | ✅ **ocurre** |
| `SERIALIZABLE` | ❌ | ❌ | ❌ | ❌ | ❌ |

**Lo que hay que llevarse: el default de Postgres (`READ COMMITTED`) permite
lost updates y write skew.** Casi nadie lo cambia y casi nadie lo sabe.

**Lost update** — el bug más común de todos:

```
T1: SELECT stock FROM productos WHERE id=1;   -- 10
T2: SELECT stock FROM productos WHERE id=1;   -- 10
T1: UPDATE productos SET stock = 9  WHERE id=1;   -- 10-1
T2: UPDATE productos SET stock = 9  WHERE id=1;   -- 10-1   ← se perdió una venta
```

Tres formas de evitarlo:

```sql
-- a) Atómico: que la base haga la resta. La mejor cuando alcanza.
UPDATE productos SET stock = stock - 1 WHERE id = 1 AND stock > 0;

-- b) Lock pesimista: reservar la fila.
SELECT stock FROM productos WHERE id = 1 FOR UPDATE;

-- c) Lock optimista: una columna de versión (lo que hace @Version de TypeORM)
UPDATE productos SET stock = 9, version = 8 WHERE id = 1 AND version = 7;
--   si afectó 0 filas, alguien te ganó -> reintentás
```

**Write skew** — el que sobrevive incluso a `REPEATABLE READ`, y el que más
sorprende: dos transacciones leen el mismo conjunto de filas, cada una decide
que puede proceder, y **cada una modifica filas distintas**. El ejemplo
clásico es el de los médicos de guardia: hay dos, la regla es "siempre tiene
que quedar al menos uno", los dos consultan a la vez, cada uno ve que el otro
está, y **los dos se dan de baja**. Ninguna modificó la misma fila, así que
ningún lock de fila lo detecta. Sólo lo atrapa `SERIALIZABLE` (o un lock
explícito sobre algo que represente la invariante).

**Deadlocks**: dos transacciones se esperan en círculo. Postgres detecta y
mata a una con `40P01`. **La prevención es siempre la misma: tomar los locks
en el mismo orden en todo el código** (por ejemplo, ordenar los ids antes de
actualizar varias filas). Y el código tiene que estar preparado para
reintentar.

Lo vas a ver en `aislamiento.ts`.

### 4. MVCC y `VACUUM` (Postgres, pero el concepto es general)

Postgres no modifica filas: **escribe una versión nueva y marca la vieja como
muerta**. Por eso los lectores nunca bloquean a los escritores ni al revés —
es lo que hace a MVCC tan bueno. El costo es que **las filas muertas quedan
ocupando lugar hasta que `VACUUM` pasa**.

Tres consecuencias que aparecen en producción:

- **`UPDATE` de una fila es casi tan caro como un `INSERT`** (escribe una
  versión nueva y actualiza todos los índices). Un `UPDATE` masivo puede
  duplicar el tamaño de la tabla.
- **Una transacción abierta mucho tiempo impide el `VACUUM`** de *todas* las
  tablas: mientras exista, las versiones viejas podrían ser necesarias. Una
  transacción olvidada abierta en un pod es una causa clásica de bloat.
  Alertá sobre `pg_stat_activity` con `state = 'idle in transaction'`.
- **Bloat**: la tabla ocupa 3x lo que deberían sus datos, las queries leen más
  páginas, todo se pone lento. Se ve en `pg_stat_user_tables.n_dead_tup`.

Y la regla operativa que sale de esto: **las transacciones se abren lo más
tarde posible y se cierran lo antes posible.** Nunca hagas una llamada HTTP
adentro de una transacción — atás una versión de la base a la latencia de un
tercero.

### 5. Replicación y el bug de `replication lag`

- **Asíncrona** (el default): el primario confirma el commit y después manda
  los cambios. Rápido, y **en un failover podés perder escrituras ya
  confirmadas**.
- **Síncrona**: el primario espera a la réplica. No perdés nada, y **cada
  commit paga el round-trip** (1-2 ms entre AZs; mucho más entre regiones).
  Si la réplica se cae, los commits se frenan.

**El bug clásico, y lo que se pregunta:**

```
POST /perfil  -> escribe en el PRIMARIO       ✅
GET  /perfil  -> lee de una RÉPLICA (lag 200 ms)
             -> devuelve el perfil VIEJO       ❌ "no se guardó"
```

El usuario guarda, la pantalla se recarga, y ve lo de antes. Rompiste
**read-your-writes**, que es la garantía de consistencia que los usuarios
esperan aunque no sepan nombrarla.

Las soluciones, de más simple a más correcta:

1. **Leer del primario después de escribir**, por N segundos (un flag en la
   sesión, o una cookie con timestamp). Simple y efectivo.
2. **Leer del primario siempre para ese usuario**, si su sesión escribió
   recientemente.
3. **Esperar el LSN**: la escritura devuelve su posición en el WAL y la
   lectura espera a que la réplica la alcance. Correcto y más trabajo.
4. **Que el cliente use lo que ya tiene**: si el `POST` devuelve el recurso
   actualizado, el front no necesita releer nada. **La solución más barata es
   no hacer la segunda query.**

Lo medís en `replication-lag.ts`.

### 6. Particionado (dentro de la misma base)

Distinto de sharding (módulo 03): el particionado es **una sola base** que
divide una tabla en tablas físicas más chicas.

```sql
CREATE TABLE eventos (id bigint, created_at timestamptz, ...)
  PARTITION BY RANGE (created_at);
CREATE TABLE eventos_2026_09 PARTITION OF eventos
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

Qué te da, y por qué suele ser mejor negocio que shardear:

- **Partition pruning**: una query con `WHERE created_at > hoy` toca **una**
  partición. El índice de la partición activa es chico y entra en RAM (la
  solución a B4 del módulo 03).
- **Borrar es instantáneo**: `DROP TABLE eventos_2025_09` en vez de un
  `DELETE` de 200 millones de filas que genera bloat y tarda horas.
- **`VACUUM` y backups por partición**, no sobre la tabla entera.

El costo: toda query que **no** filtre por la clave de partición toca todas
las particiones; y las claves únicas globales se complican (el `UNIQUE` tiene
que incluir la columna de partición).

### 7. CAP y PACELC

**CAP**: ante una **partición de red** (P), elegís entre **consistencia** (C)
y **disponibilidad** (A).

El error que hay que evitar: **"elijo CA" no es una respuesta válida.** La
partición no se elige — ocurre. CAP dice qué hacés *cuando ya ocurrió*. Un
sistema "CA" es un sistema que simplemente no tolera particiones.

**PACELC** es más útil en la práctica porque describe también el caso normal:

> **Si hay Partición: A o C. Else (sin partición): Latencia o Consistencia.**

Ese *else* es donde vive tu sistema el 99,99% del tiempo. Leer de una réplica
es elegir **L** sobre **C**. Esperar confirmación síncrona es elegir **C**
sobre **L**. **La decisión que tomás todos los días es la del else**, y por
eso PACELC describe mejor la realidad que CAP.

Ejemplos: Postgres con réplicas asíncronas = PA/EL. DynamoDB con lecturas
fuertemente consistentes = PC/EC. Cassandra = PA/EL (ajustable por query).

### 8. Migraciones sin downtime

Es el *expand / migrate / contract* del módulo 02, aplicado al esquema. Y la
parte peligrosa es qué **bloquea**:

| Operación | ¿Bloquea? |
| --- | --- |
| `ADD COLUMN` sin default | ✅ Seguro, instantáneo |
| `ADD COLUMN ... DEFAULT x` | ✅ Seguro en PG ≥ 11 (antes reescribía la tabla) |
| `ADD COLUMN ... NOT NULL` sin default | ❌ Falla si hay filas |
| `CREATE INDEX` | 🔴 **Bloquea las escrituras** de toda la tabla |
| `CREATE INDEX CONCURRENTLY` | ✅ No bloquea (tarda más, y puede fallar dejando un índice inválido) |
| `ALTER COLUMN TYPE` | 🔴 **Reescribe toda la tabla** |
| `DROP COLUMN` | ✅ Instantáneo (marca la columna, no reescribe) |
| `ADD FOREIGN KEY` | 🔴 Bloquea, salvo `NOT VALID` + `VALIDATE CONSTRAINT` después |

Y el detalle que rompe producción aunque tu `ALTER` sea instantáneo: **para
ejecutarlo hace falta un `ACCESS EXCLUSIVE` lock, y para tomarlo hay que
esperar a que terminen las transacciones en curso. Mientras tanto, la
migración se pone en la cola de locks y bloquea a TODAS las que llegan
después.** Un `ALTER` de 1 ms detrás de una query lenta de 30 segundos
frena la tabla 30 segundos.

Por eso, siempre:

```sql
SET lock_timeout = '3s';   -- si no consigo el lock rápido, fallo y reintento
ALTER TABLE ...;
```

**Renombrar una columna nunca se hace en un solo paso**: agregás la nueva,
escribís en las dos, migrás los lectores, y recién después borrás la vieja.
Igual que los contratos de protobuf del módulo 02: es el mismo patrón.

### 9. Aplicado a tu stack (TypeORM / Prisma / NestJS)

- **El N+1 es el bug de performance más común de cualquier ORM.** Traés 50
  órdenes y después, por cada una, el ORM pide el cliente: 51 queries. Con
  `relations` / `include` / `JOIN` son 2. **Mirá el log de queries, no el
  código**: el N+1 es invisible leyendo.
- **`lazy: true` en TypeORM es una máquina de N+1.** Un `.map()` sobre una
  relación lazy dispara una query por elemento.
- **Las transacciones tienen que usar el mismo `EntityManager`.** Si adentro
  de una transacción llamás a un servicio que usa el repositorio global, esa
  query corre **fuera** de la transacción. Es un bug sutil y muy frecuente.
- **Pool de conexiones**: dimensionalo con la Ley de Little (módulo 01), y
  poné **PgBouncer** apenas tengas más de un puñado de pods.
- **Migraciones automáticas en producción, nunca.** `synchronize: true` de
  TypeORM en producción es un borrado de datos esperando a ocurrir.
- **Timeouts en la base, no sólo en la app**: `statement_timeout` e
  `idle_in_transaction_session_timeout` son tu red de seguridad contra el
  bloat de la sección 4.

## Lo que vas a correr

```bash
node modules/05-bases-de-datos/indices.ts
node modules/05-bases-de-datos/aislamiento.ts
node modules/05-bases-de-datos/replication-lag.ts
```

1. **`indices.ts`** — simula un B-tree y compara seq scan, index scan e index
   only scan según la selectividad; después mide qué le hace cada índice
   nuevo a las escrituras. Vas a ver el punto exacto donde el planner deja de
   usar el índice, y por qué tiene razón.
2. **`aislamiento.ts`** — reproduce *lost update*, *write skew* y *phantom*
   con transacciones concurrentes, y muestra qué las evita: el `UPDATE`
   atómico, el `FOR UPDATE`, la columna de versión y `SERIALIZABLE`. Es la
   base directa del módulo 06.
3. **`replication-lag.ts`** — cuántos usuarios ven el dato viejo después de
   escribir, según el lag y la velocidad con que recargan. El número es mucho
   peor de lo que parece.

## Para pensar / próximo paso

- Tenés `SELECT * FROM ordenes WHERE tenant_id = ? AND estado = ? ORDER BY
  created_at DESC LIMIT 20`. ¿Qué índice creás? ¿En qué orden van las
  columnas y por qué?
- Dos requests con la misma `Idempotency-Key` llegan **al mismo tiempo**. Con
  `READ COMMITTED` y un `SELECT` antes del `INSERT`, ¿qué pasa? ¿Y con un
  `UNIQUE`? *(Esto es, literalmente, la primera pregunta del módulo 06.)*
- Tu `POST /perfil` funciona pero el usuario dice que "a veces no se guarda".
  Los logs no muestran ningún error. ¿Qué pasó y cómo lo confirmás?

## Fuentes

- **Martin Kleppmann**, *Designing Data-Intensive Applications*, caps. 3, 5, 7
  y 9. Es **el** libro de este módulo; si leés uno solo de todo el path, éste.
- **Postgres**, *Transaction Isolation*:
  <https://www.postgresql.org/docs/current/transaction-iso.html>
- **Postgres**, *Explicit Locking* y `SKIP LOCKED`:
  <https://www.postgresql.org/docs/current/explicit-locking.html>
- **Use The Index, Luke** — índices explicados de verdad:
  <https://use-the-index-luke.com/>
- **Daniel Abadi**, *Consistency Tradeoffs in Modern Distributed Database
  System Design* (PACELC): <https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf>
- **Strong Migrations** — qué operación bloquea y cómo evitarlo:
  <https://github.com/ankane/strong_migrations#checks>

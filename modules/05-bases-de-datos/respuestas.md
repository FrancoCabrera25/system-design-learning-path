# Respuestas modelo — Módulo 05

> Abrilo **después** de escribir las tuyas en `mis-respuestas/05.md`.

---

## Bloque A — Conceptos

### A1 — "¿SQL o NoSQL?"

La categoría es una mala forma de plantearlo, por dos motivos: "NoSQL" agrupa
cosas que no tienen nada que ver entre sí (Redis y ClickHouse no comparten
nada), y varios "NoSQL" hoy tienen SQL.

**La pregunta que de verdad decide es:**

> **¿Conocés tus patrones de acceso de antemano, y van a cambiar?**

- En un **relacional**, no hace falta saberlos: normalizás, y cuando aparece
  una consulta nueva, creás un índice. **La flexibilidad de consulta es el
  producto.**
- En **DynamoDB o Cassandra**, el patrón de acceso **define el esquema**: se
  diseña la partition key y la sort key para las queries que vas a hacer. Si
  aparece una consulta nueva, no agregás un índice: **rediseñás** (o agregás
  un GSI, que es otra copia de los datos).

Eso —y no "SQL vs NoSQL"— es el trade-off real.

Mi default, dicho tal cual: **Postgres hasta que un requisito concreto me
obligue a salir.** Hace JSONB, full-text, geoespacial con PostGIS, colas con
`SKIP LOCKED` y particionado nativo. La mayoría de los sistemas que "necesitan
NoSQL" necesitan un índice.

Qué me haría salir, con nombre y apellido:

| Requisito | Motor |
| --- | --- |
| Escrituras que ningún primario aguanta, con escala horizontal transparente | DynamoDB, Cassandra |
| Agregaciones sobre miles de millones de filas | ClickHouse, BigQuery |
| Latencia sub-milisegundo por clave | Redis |
| Recorridos de muchos saltos | Neo4j (y aun así Postgres llega lejos con CTEs recursivas) |

### A2 — `Index Only Scan`

Un `Index Scan` hace dos cosas: baja el árbol del índice **y después va a
buscar la fila a la tabla** (el *heap*), con un salto aleatorio por fila. Un
`Index Only Scan` **se saltea el segundo paso**, porque todo lo que la query
pide ya está en el índice.

En el modelo de costos, la diferencia es de 2x a 100x, y crece con la cantidad
de filas: los saltos al heap son lo que domina.

**Cómo conseguirlo:** que el índice contenga **todas** las columnas que la
query referencia — en el `SELECT`, en el `WHERE` y en el `ORDER BY`.

```sql
-- SELECT id, total FROM ordenes WHERE tenant_id=$1 ORDER BY created_at DESC
CREATE INDEX ON ordenes (tenant_id, created_at DESC) INCLUDE (id, total);
```

`INCLUDE` guarda columnas en el índice **sin** que formen parte de la clave:
no afectan el orden ni el tamaño de la parte buscable, sólo viajan como carga.

**La letra chica que casi nadie menciona, y que suma mucho decir:** Postgres
sólo puede evitar el heap si la página está marcada como *all-visible* en el
**visibility map**, y eso lo mantiene el `VACUUM`. En una tabla con muchas
escrituras y autovacuum atrasado, **el `Index Only Scan` degrada a algo
parecido a un `Index Scan`** aunque el plan diga "Index Only". Se ve en el
`EXPLAIN ANALYZE` como `Heap Fetches: <número alto>`.

### A3 — Por qué un índice puede hacer más lenta la app

1. **Cada `INSERT`/`UPDATE`/`DELETE` actualiza todos los índices.** Con 8
   índices, un insert son 9 escrituras. Es la razón principal, y hace que el
   throughput de escritura caiga a menos de la mitad.
2. **Compite por la RAM.** El buffer pool es finito: un índice que nadie usa
   **desaloja** páginas que sí se usaban, y degrada queries que no tienen
   nada que ver con él.
3. **Puede confundir al planner.** Con varios índices parecidos, a veces elige
   el peor — sobre todo con estadísticas desactualizadas.
4. **Crearlo bloquea.** `CREATE INDEX` toma un lock que **frena las escrituras
   de toda la tabla** hasta terminar. En producción, siempre
   `CREATE INDEX CONCURRENTLY` (que tarda el doble, hace dos pasadas, y puede
   dejar un índice inválido si falla — hay que chequear `pg_index.indisvalid`).

Quinta, más sutil: en Postgres, **un `UPDATE` que toca una columna indexada
impide el optimización HOT** (*heap-only tuple*), que permitiría escribir la
versión nueva sin tocar los índices. Indexar una columna que se actualiza
seguido es especialmente caro por eso.

### A4 — ACID y por qué la "I" tiene grados

- **A**tomicidad: la transacción ocurre entera o no ocurre.
- **C**onsistencia: al terminar, se cumplen las restricciones declaradas
  (`UNIQUE`, `CHECK`, FKs). Es la letra menos interesante: la garantiza el
  esquema, no el motor.
- **I**solation: las transacciones concurrentes no se pisan.
- **D**urabilidad: lo commiteado sobrevive a un corte de luz.

**Por qué la "I" tiene grados:** el aislamiento perfecto significa que el
resultado sea equivalente a haberlas ejecutado **una detrás de otra**, y eso
es caro: exige detectar conflictos y abortar transacciones. Los motores
ofrecen niveles más débiles —y más rápidos— que permiten ciertas anomalías.
**Las otras tres letras son binarias; ésta se negocia.**

**El default de Postgres es `READ COMMITTED`**, y deja pasar:

- **non-repeatable read**: leés la misma fila dos veces en la misma
  transacción y tiene valores distintos.
- **phantom read**: la misma query devuelve filas nuevas la segunda vez.
- **lost update**: dos read-modify-write concurrentes, uno se pierde.
- **write skew**: dos decisiones basadas en el mismo estado que juntas lo
  violan.

Lo importante: **casi nadie lo cambia y casi nadie sabe que permite esas
cuatro.** El código "funciona" en desarrollo, donde no hay concurrencia.

### A5 — Lost update vs write skew

| | **Lost update** | **Write skew** |
| --- | --- | --- |
| Qué pasa | Dos transacciones modifican **la misma fila**; una escritura se pierde | Dos transacciones leen el mismo conjunto y modifican **filas distintas** |
| Ejemplo | Dos ventas restan del mismo stock | Los dos médicos de guardia se dan de baja |
| ¿Hay conflicto de escritura? | **Sí**: la misma fila | **No**: filas distintas |
| ¿Lo evita `FOR UPDATE` de la fila? | **Sí** | **No** |
| ¿Lo evita `REPEATABLE READ`? | Sí (en PG aborta con 40001) | **No** |
| Qué lo evita | `UPDATE` atómico, `FOR UPDATE`, versión | `SERIALIZABLE`, o bloquear algo que represente la invariante |

**Por qué `FOR UPDATE` resuelve uno y no el otro:** `FOR UPDATE` bloquea
**filas que existen y que vas a tocar**. En el lost update, las dos
transacciones van por la misma fila, así que una espera a la otra y lee el
valor ya actualizado. En el write skew **cada una bloquea una fila distinta**
— no hay ninguna espera, porque no hay ningún recurso en común que bloquear.

El problema del write skew no es la escritura: es que **la decisión se tomó
sobre una lectura que dejó de ser cierta**, y los locks de fila no protegen
lecturas. Por eso hace falta `SERIALIZABLE` (que rastrea las dependencias de
lectura-escritura) o bloquear explícitamente **la invariante**, no las filas:
una fila `guardias` que represente el turno, o un `pg_advisory_xact_lock`.

### A6 — MVCC

Postgres **no modifica filas en el lugar**: cada `UPDATE` escribe una versión
nueva y marca la vieja como muerta con el rango de transacciones que la ven.
Cada transacción tiene un *snapshot* que determina qué versiones son visibles
para ella.

El beneficio, que es enorme: **los lectores nunca bloquean a los escritores ni
al revés.** Un reporte de 10 minutos no frena las escrituras.

**Por qué un `UPDATE` es casi tan caro como un `INSERT`:** escribe una tupla
nueva completa (no sólo la columna que cambió) **y** agrega entradas en todos
los índices que apunten a esa tupla nueva. La vieja queda ocupando lugar hasta
que pase el `VACUUM`. Un `UPDATE` masivo sobre 50M filas puede **duplicar el
tamaño de la tabla** antes de que el vacuum recupere el espacio.

**Por qué una transacción abierta 40 minutos degrada tablas que ni toca:** el
`VACUUM` sólo puede borrar versiones que **ninguna transacción viva pueda
necesitar**. Mientras exista una transacción con un snapshot viejo, esas
versiones se conservan **en todas las tablas**, porque el sistema no sabe qué
va a mirar. El bloat crece en todo el sistema.

Casos típicos de transacción olvidada: un pod que abrió una transacción y se
colgó esperando una llamada HTTP; una sesión `idle in transaction` de alguien
que dejó un cliente SQL abierto. Las defensas:

```sql
SET idle_in_transaction_session_timeout = '30s';
SET statement_timeout = '30s';
-- y alertar sobre pg_stat_activity donde state = 'idle in transaction'
```

Y la regla: **nunca hagas una llamada de red adentro de una transacción.**
Atás la salud de toda la base a la latencia de un tercero.

### A7 — CAP y PACELC

**CAP:** ante una **partición de red** (P) —dos partes del sistema no se ven—
tenés que elegir entre:

- **C**onsistencia: rechazás operaciones que no podés garantizar consistentes.
- **A**vailability: seguís respondiendo, aceptando que las respuestas pueden
  divergir.

**Por qué "elijo CA" es incorrecto:** la partición **no se elige**. Ocurre —
un switch, un cable, una zona de disponibilidad. CAP no ofrece tres opciones
entre las que elegir: describe qué te queda **cuando la partición ya ocurrió**.
Decir "CA" es decir "asumo que nunca hay particiones", que sólo es defendible
en una sola máquina.

**PACELC** lo completa, y es más útil porque describe el caso normal:

> **Si hay Partición: A o C. Else (sin partición): Latencia o Consistencia.**

Ese **else** es donde tu sistema vive el 99,99% del tiempo, y es donde tomás
decisiones todos los días:

- Leer de una réplica asíncrona → elegís **L** sobre **C** (y aparece el bug
  de C4).
- Esperar confirmación síncrona de la réplica → elegís **C** sobre **L**
  (+1-2 ms por commit entre AZs).
- `DynamoDB` con `ConsistentRead: true` → **C** sobre **L**, al doble de costo
  por lectura.

Clasificaciones: Postgres con réplicas asíncronas = **PA/EL**. DynamoDB con
lecturas fuertemente consistentes = **PC/EC**. Cassandra = **PA/EL**, y
ajustable por query con los quórums.

**Y la observación que cierra:** la consistencia no es una propiedad del
motor, es una propiedad **por operación**. En el mismo Postgres, leer del
primario es fuerte y leer de la réplica es eventual. La pregunta correcta no
es "¿es consistente mi base?" sino **"¿qué garantía necesita ESTA lectura?"**.

> **Rúbrica bloque A**
> - **Mid:** define ACID y CAP, sabe que hay índices y réplicas.
> - **Senior:** sabe que `READ COMMITTED` permite lost update, explica
>   `Index Only Scan` y el visibility map, y por qué "CA" no existe.
> - **Staff:** distingue lost update de write skew por el conflicto de
>   escritura, conecta transacciones largas con bloat global, y trata la
>   consistencia como decisión por operación.

---

## Bloque B — Índices y queries

### B1 — El índice para la query más usada

**(a)**
```sql
CREATE INDEX idx_ordenes_tenant_pend ON ordenes (tenant_id, created_at DESC)
  WHERE estado = 'PENDIENTE';
```

**(b) El orden de las columnas.** La regla es **igualdad primero, orden
después**:

1. `tenant_id` va primero porque es una **igualdad** y es **selectiva** (hay
   muchos tenants).
2. `created_at DESC` va después porque es el `ORDER BY`. Al estar el índice
   ya ordenado por `(tenant_id, created_at DESC)`, Postgres lee las primeras
   20 entradas del rango del tenant y **termina**: no hay paso de `Sort`, y el
   `LIMIT 20` corta enseguida. **Ése es el verdadero premio de esta query**, no
   el filtrado.
3. `estado` no va en la clave: va en el `WHERE` del índice parcial, por (d).

Si en cambio hiciera `(created_at, tenant_id)`, para traer las 20 más nuevas
de un tenant habría que recorrer el índice entero filtrando — el orden global
por fecha no sirve de nada cuando primero hay que filtrar por tenant.

**(c) Para `Index Only Scan`**, el índice tiene que tener todas las columnas
que la query menciona:

```sql
CREATE INDEX ... ON ordenes (tenant_id, created_at DESC) INCLUDE (id, total)
  WHERE estado = 'PENDIENTE';
```

(`estado` no hace falta en `INCLUDE`: el índice parcial garantiza que todas
sus filas son `'PENDIENTE'`, así que ese valor es conocido.) Y la salvedad de
A2: sólo funciona de verdad si el visibility map está al día — mirá
`Heap Fetches` en el `EXPLAIN ANALYZE`.

**(d) ¿Conviene indexar `estado`?** **Solo, no**: con el 85% de las filas en
un valor, un índice sobre `estado` nunca se usaría para buscar
`'COMPLETADA'` (módulo: por encima del ~0,5% el planner prefiere el seq scan)
y sólo haría más lentas las escrituras.

Pero acá no queremos buscar `'COMPLETADA'`: queremos `'PENDIENTE'`, que
probablemente sea el 1-2% de las filas. La respuesta correcta es el **índice
parcial**: sólo indexa las pendientes, así que es **decenas de veces más
chico**, entra cómodo en RAM, y sólo se actualiza cuando una orden entra o
sale de ese estado. Es la misma idea que hace funcionar al outbox del
módulo 02.

### B2 — `INDEX (tenant_id, created_at)`

- **(a)** `tenant_id = 5 AND created_at > ...` → ✅ **Usa el índice completo.**
  Igualdad en la primera, rango en la segunda: el caso ideal.
- **(b)** `tenant_id = 5` → ✅ **Usa el prefijo.** Un índice compuesto sirve
  para cualquier prefijo por la izquierda.
- **(c)** `created_at > ...` → ❌ **No lo usa.** Es la guía telefónica
  ordenada por (apellido, nombre): buscar "todos los Juan" no se beneficia.
  Hace falta un índice propio sobre `created_at`.
  *(Matiz para ser precisos: Postgres 18 introdujo* skip scan *para índices
  compuestos, que puede saltar valores de la columna líder — pero sólo rinde
  cuando esa columna tiene POCOS valores distintos. Con `tenant_id`, que tiene
  miles, no ayuda. La regla práctica sigue siendo la misma.)*
- **(d)** `tenant_id IN (5, 9) ORDER BY created_at DESC` → ⚠️ **Usa el índice
  para filtrar, pero probablemente necesite ordenar.** Dentro de cada tenant
  las filas vienen ordenadas, pero **intercaladas entre los dos tenants no**,
  así que hace falta combinarlas. Postgres puede resolverlo con un `Sort`
  sobre el resultado, o con `Incremental Sort` / un merge de ambos rangos si
  hay `LIMIT`. Con dos tenants es barato; con `IN` de 500 tenants, el `Sort`
  se come la ventaja del índice.
- **(e)** `lower(email) = 'a@b.com'` con `INDEX (email)` → ❌ **No lo usa.**
  **Cualquier función sobre la columna anula el índice**, porque el índice
  guarda `email`, no `lower(email)`. Se arregla con un índice funcional:
  ```sql
  CREATE INDEX ON usuarios (lower(email));
  ```
  Lo mismo pasa con castings implícitos (`WHERE id = '123'` sobre un `bigint`
  puede o no resolverse) y con `WHERE created_at::date = '2026-09-01'` — que
  se reescribe como un rango `>= ... AND < ...` para poder usar el índice.
  **Es la causa número uno de "creé el índice y no lo usa".**

### B3 — 11 índices en una tabla de 200M filas

- **(a)** `1 + 11 = **12 escrituras** por `INSERT`` (una al heap, once a los
  índices), más el costo de los splits de página. Agregar dos más lo lleva a
  14: **un 17% más caro cada escritura**, para siempre.
- **(b) Cómo averiguar cuáles no se usan:**
  ```sql
  SELECT relname, indexrelname, idx_scan,
         pg_size_pretty(pg_relation_size(indexrelid)) AS tamano
  FROM pg_stat_user_indexes
  WHERE schemaname = 'public'
  ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
  ```
  Con dos advertencias que hay que decir: **las estadísticas son desde el
  último `pg_stat_reset()`** (si fue ayer, no significan nada), y **son por
  nodo**: `idx_scan = 0` en el primario no dice nada sobre si las réplicas lo
  usan. Si mandás las lecturas a réplicas, tenés que mirar ahí.
- **(c) Cuáles NO podés borrar aunque `idx_scan = 0`:**
  1. **El de la primary key** y los que respaldan un **`UNIQUE`**: no son
     índices, son restricciones de integridad implementadas con un índice.
     Borrarlos elimina la garantía.
  2. **Los que sostienen una foreign key del lado que referencia.** Postgres
     no los exige, pero sin ellos cada `DELETE`/`UPDATE` en la tabla padre
     hace un **seq scan** en la hija para verificar la FK. `idx_scan` no
     cuenta esas verificaciones igual que una query.
  3. **Los de queries raras pero críticas**: un reporte mensual, un job de
     conciliación, un endpoint de soporte. `idx_scan` bajo, y el día que se
     usa sin el índice tarda una hora.
  4. Los que se usan sólo para **ordenar** (`ORDER BY` con `LIMIT`) pueden
     tener contadores engañosos según la versión.

### B4 — `Seq Scan` sobre 50M filas con un índice aplicable

1. **La query no es selectiva.** Trae más del ~0,5-5% de las filas, y el seq
   scan es genuinamente más barato. **El planner tiene razón** — la pregunta
   entonces no es cómo forzar el índice sino cómo hacer la query selectiva
   (índice parcial, filtro extra, precálculo).
2. **Estadísticas desactualizadas.** El autovacuum quedó atrás y el planner
   cree que la query devuelve un millón de filas cuando devuelve diez. Se
   arregla con `ANALYZE tabla;` y se diagnostica comparando `rows=` estimado
   contra `actual rows=` en el `EXPLAIN ANALYZE` — **si difieren por órdenes
   de magnitud, es esto.**
3. **La columna está envuelta en una función o hay un cast.** El caso B2(e).
4. **El índice no matchea**: le pedís por una columna que no es el prefijo del
   índice compuesto, o el `ORDER BY` tiene otra dirección y no hay `DESC` en
   la definición.
5. **`random_page_cost` mal calibrado.** El default es 4, pensado para discos
   rotacionales. En SSD/NVMe el valor razonable es **1.1**, y con el default
   el planner **sobreestima sistemáticamente** el costo de los índices y
   prefiere seq scans. Es un cambio de una línea que arregla planes en toda la
   base, y casi nadie lo toca.
6. **La tabla es chica** o está toda en caché: leerla entera cuesta nada.

> **Rúbrica bloque B**
> - **Mid:** crea el índice con las columnas correctas.
> - **Senior:** justifica el ORDEN (igualdad, después rango/ordenamiento),
>   propone el índice parcial, y sabe que una función sobre la columna anula el índice.
> - **Staff:** menciona `INCLUDE` + visibility map, `random_page_cost` en SSD,
>   y que `pg_stat_user_indexes` es por nodo y desde el último reset.

---

## Bloque C — Concurrencia y consistencia

### C1 — El `findOne` + `save` de siempre

**(a) Lost update.** La secuencia con dos requests:

```
R1: SELECT stock -> 10
R2: SELECT stock -> 10
R1: if (10 > 0) ok
R2: if (10 > 0) ok
R1: UPDATE SET stock = 9
R2: UPDATE SET stock = 9      <-- se vendieron 2, el stock bajó 1
```

Y no son dos: son 500. El `save()` de TypeORM escribe **el objeto que tenés en
memoria**, calculado con un valor que puede tener cientos de milisegundos.

**(b) ¿Lo arregla una transacción? NO.** Y ésta es la parte que evalúan.

Una transacción te da **atomicidad** (las dos sentencias ocurren o no ocurren)
y **aislamiento del nivel configurado** — pero con `READ COMMITTED`, cada
sentencia ve el estado commiteado **al momento de ejecutarse**, y nada impide
que otra transacción haya cambiado la fila entre tu `SELECT` y tu `UPDATE`.

**Transacción ≠ exclusión mutua.** Envolver este código en
`@Transaction()` no cambia absolutamente nada, y es el malentendido más
extendido sobre transacciones.

**(c) Tres arreglos:**

```sql
-- 1) UPDATE ATÓMICO — la mejor cuando la operación entra en una sentencia
UPDATE productos SET stock = stock - 1 WHERE id = $1 AND stock > 0;
--   Chequeá las filas afectadas: si es 0, no había stock.
```
Sin locks, sin reintentos, sin round-trips extra. **Si podés escribirlo así,
no uses nada más.**

```sql
-- 2) LOCK PESIMISTA — cuando entre medio hay lógica que no entra en un UPDATE
SELECT stock FROM productos WHERE id = $1 FOR UPDATE;
```
En TypeORM: `{ lock: { mode: 'pessimistic_write' } }`. Costo: las
transacciones se **serializan** sobre esa fila, así que una fila caliente se
convierte en el cuello de botella del sistema. Y si distintos caminos toman
filas en orden distinto, hay deadlock (C3).

```ts
// 3) LOCK OPTIMISTA — barato si la contención es baja
@Entity() class Producto { @VersionColumn() version: number; }
// UPDATE ... SET stock=?, version=? WHERE id=? AND version=?
// 0 filas afectadas -> alguien te ganó -> reintentar
```
Costo: con contención alta, los reintentos se comen todo. En la simulación,
**100 ventas exitosas costaron ~2.000 reintentos**.

**(d)** Con el código de arriba, 500 compradores y stock 100: la simulación
vende **las 500** y deja el stock en 98. Vendiste **400 unidades que no
existen**, y el sistema no reportó ni un error.

### C2 — Dos requests con la misma `Idempotency-Key` ⏱️

**(a) Con `READ COMMITTED`:** las dos hacen el `SELECT`, **las dos no
encuentran nada**, las dos hacen el `INSERT` y **las dos procesan el pago**.
Es exactamente el mismo bug que C1, en otro disfraz: una decisión tomada sobre
una lectura que dejó de ser cierta.

Si no hay `UNIQUE` sobre la clave, quedan dos filas y **el cliente pagó dos
veces**.

**(b) ¿Lo arregla `SERIALIZABLE`?** Técnicamente sí: Postgres detecta el
conflicto y aborta una con `40001`. Pero el costo es alto y hay que decirlo:
tu código **tiene que reintentar** (si no, cambiaste un cobro duplicado por un
error 500), el aislamiento serializable agrega overhead de seguimiento en toda
la transacción, y bajo contención la tasa de abortos sube. **Es una solución
pesada para algo que un `UNIQUE` resuelve gratis.**

**(c) La solución correcta:**

```sql
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,          -- <-- ACÁ está la garantía
  status      text NOT NULL,             -- IN_PROGRESS | COMPLETED
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

```ts
const insert = await tx.createQueryBuilder()
  .insert().into(IdempotencyKey)
  .values({ key, status: 'IN_PROGRESS' })
  .orIgnore()                       // ON CONFLICT DO NOTHING
  .execute();

if (insert.identifiers.length === 0) {
  const previa = await tx.findOne(IdempotencyKey, { where: { key } });
  if (previa.status === 'COMPLETED') return previa.response;   // devolvés lo mismo
  throw new ConflictException('Request en curso con esta clave'); // 409
}
// ganamos: procesamos, y al terminar marcamos COMPLETED con la respuesta
```

**Por qué no depende del nivel de aislamiento:** el índice único **no es una
regla lógica, es una estructura física**. El segundo `INSERT` no "consulta y
decide": intenta escribir una entrada en un índice B-tree donde ya hay una, y
el motor lo bloquea a nivel de página, **por debajo del sistema de snapshots**.
Funciona igual en `READ COMMITTED` que en `SERIALIZABLE`.

Es la misma idea del `@Cron` del módulo 03: **no intentes evitar la ejecución
concurrente; hacé que el resultado sea el mismo.**

**(d) La segunda llega mientras la primera procesa.** El comportamiento
correcto —y el que usa Stripe— es **`409 Conflict`**, con un mensaje que diga
que hay una request en curso con esa clave, y un `Retry-After`.

Lo importante es **por qué**, y es un detalle de diseño que vale oro: la fila
`IN_PROGRESS` tiene que estar **commiteada en su propia transacción corta**,
antes de empezar el trabajo. Si la insertás dentro de la transacción larga que
procesa el pago, el `INSERT` de la segunda request **se queda bloqueado
esperando** a que la primera commitee — y con un pago de 4 segundos, tenés una
conexión tomada 4 segundos sin hacer nada. Bajo carga, eso agota el pool.

Lo que **no** hay que hacer es esperar y devolver el resultado de la primera:
suena más amable y convierte cada reintento en una conexión bloqueada.

Módulo 06 y 13.

### C3 — Deadlocks intermitentes

**(a) La causa casi segura: dos transacciones toman los mismos locks en orden
distinto.**

```
T1: UPDATE cuentas WHERE id = 1;   T2: UPDATE cuentas WHERE id = 2;
T1: UPDATE cuentas WHERE id = 2;   T2: UPDATE cuentas WHERE id = 1;
    ↑ espera a T2                      ↑ espera a T1        -> deadlock
```

Postgres lo detecta (~1 s por defecto) y **mata a una** con `40P01`.

**(b) La regla que vale para todo el código: tomar siempre los locks en un
orden determinístico.** En la práctica: **ordená los ids antes de actualizar**.

```ts
const ids = [...cuentasAfectadas].sort((a, b) => a - b);   // <-- esto
for (const id of ids) await tx.update(Cuenta, id, ...);
```

Si todo el código respeta el mismo orden total, **el ciclo no se puede
formar**. Es un arreglo de una línea que elimina la clase entera.

Segunda regla: **transacciones cortas**. Menos tiempo con locks tomados es
menos probabilidad de cruzarse.

**(c) ¿Se pueden eliminar por completo? No**, y decirlo es parte de la buena
respuesta. Aunque ordenes tus escrituras, hay caminos que no controlás: el
propio motor toma locks en el orden en que el plan visita las filas, una FK
puede bloquear la fila padre, un índice único puede bloquear, un `MERGE` o un
trigger pueden introducir orden nuevo.

**Por eso la aplicación tiene que capturar `40P01` y reintentar**, con backoff
y jitter (módulo 08), y con un límite. El deadlock es un error **transitorio y
esperable**: reintentar es la respuesta correcta, no un parche. Y la operación
tiene que ser idempotente para que reintentar sea seguro — otra vez el
módulo 06.

### C4 — "A veces no se guarda"

**(a)** El `POST` escribe en el **primario**; el `GET` que dispara el front
inmediatamente después lee de una **réplica** que todavía no recibió el
cambio. Rompiste **read-your-writes**. Los dos requests devuelven 200 con
datos válidos: no hay error en ningún lado.

**(b) Por qué no lo pueden reproducir a mano:** la simulación lo muestra
crudo. Con un lag p50 de ~20 ms, si el front relee **inmediatamente** falla
prácticamente el **100%** de las veces; si alguien lo prueba a mano y tarda 3
segundos en mirar, falla **menos del 1%**. El bug es un problema de carrera
de milisegundos, y **el humano que investiga es demasiado lento para
disparalo**. Por eso el ticket se cierra como "no reproducible".

**(c) Las cuatro soluciones, por costo:**

1. **Que el `POST` devuelva el recurso actualizado** y el front use eso.
   **Costo cero**: la solución más barata es no hacer la segunda query, y
   resuelve el caso más frecuente.
2. **Leer del primario durante N segundos después de escribir**, marcando la
   sesión. Costo bajo: con un ratio 12:1, mandás al primario ~20% de las
   lecturas y seguís descargándolo del 80%.
3. **Esperar el LSN**: el `POST` devuelve `pg_current_wal_lsn()` y la lectura
   espera a que la réplica lo alcance (o cae al primario). Correcto de verdad,
   y hay que plomearlo por toda la aplicación.
4. **Leer siempre del primario**: resuelve el problema y tira a la basura la
   razón por la que tenías réplicas. Válido para endpoints puntuales, no como
   política.

Y la pregunta que ordena: **¿qué lecturas necesitan read-your-writes?** Casi
nunca todas. El perfil que acabás de editar, sí; el listado de productos, no.
**Es una decisión por endpoint.**

**(d) La alerta:**
```sql
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```
con umbral en segundos. Sin esto, un pico de lag durante una migración o un
batch es **completamente invisible**: la app no se cae, responde 200 a todo,
con datos de hace medio minuto. Los usuarios crean duplicados porque "no
apareció", y las métricas de error están en cero.

> **Rúbrica bloque C**
> - **Mid:** identifica el lost update y propone una transacción.
> - **Senior:** sabe que la transacción sola NO lo arregla, da los tres
>   arreglos con sus costos, y resuelve la idempotencia con un `UNIQUE`.
> - **Staff:** explica por qué el `UNIQUE` funciona por debajo del aislamiento,
>   ve que la fila `IN_PROGRESS` necesita su propia transacción corta, y
>   acepta que los deadlocks no se eliminan sino que se reintentan.

---

## Bloque D — Operación y diseño

### D1 — Agregar `country` a 80M filas sin downtime

```
PASO 1 — ADD COLUMN, nullable, sin default          [deploy de migración]
  ALTER TABLE usuarios ADD COLUMN country text;
  Instantáneo: sólo toca el catálogo, no reescribe la tabla.
  (En PG >= 11 agregar un DEFAULT tampoco reescribe. En PG 10 y anteriores,
   sí: ahí se agrega nullable y se pobla aparte.)

PASO 2 — LA APP ESCRIBE LA COLUMNA NUEVA            [deploy de aplicación]
  Todo INSERT/UPDATE ya setea country. Sin esto, el backfill del paso 3
  corre una carrera contra el tráfico y nunca termina de cerrar.

PASO 3 — BACKFILL POR LOTES                         [job, no migración]
  UPDATE usuarios SET country = ...
   WHERE id BETWEEN $1 AND $2 AND country IS NULL;   -- 5.000 filas por vuelta
  Con una pausa entre lotes.
  NUNCA un UPDATE único de 80M filas: es una transacción larguísima que
  bloquea el VACUUM de TODA la base (A6), genera 80M tuplas muertas y
  hace crecer el WAL sin control.

PASO 4 — VERIFICAR
  SELECT count(*) FROM usuarios WHERE country IS NULL;   -- tiene que dar 0

PASO 5 — EL ÍNDICE, SIN BLOQUEAR
  CREATE INDEX CONCURRENTLY idx_usuarios_country ON usuarios (country);
  Después: SELECT indisvalid FROM pg_index WHERE indexrelid = '...'::regclass;
  Si quedó inválido (puede pasar si falla), se dropea CONCURRENTLY y se
  reintenta.

PASO 6 — NOT NULL SIN ESCANEAR BLOQUEANDO
  ALTER TABLE usuarios
    ADD CONSTRAINT country_nn CHECK (country IS NOT NULL) NOT VALID;  -- instantáneo
  ALTER TABLE usuarios VALIDATE CONSTRAINT country_nn;   -- escanea SIN bloquear escrituras
  ALTER TABLE usuarios ALTER COLUMN country SET NOT NULL;
    -- PG >= 12 usa el CHECK ya validado y se saltea el escaneo completo
  ALTER TABLE usuarios DROP CONSTRAINT country_nn;       -- ya es redundante
```

**Qué bloquea y cómo se evita:**

| Operación | Bloquea | Cómo se evita |
| --- | --- | --- |
| `CREATE INDEX` | 🔴 Escrituras de toda la tabla | `CONCURRENTLY` |
| `SET NOT NULL` directo | 🔴 Escaneo completo con lock | El `CHECK NOT VALID` + `VALIDATE` del paso 6 |
| `UPDATE` masivo | 🔴 Bloat + WAL + vacuum global | Lotes con pausa |

**Por qué un `ALTER` instantáneo puede frenar la tabla 30 segundos:** el
`ALTER` necesita un **`ACCESS EXCLUSIVE` lock**. Para tomarlo tiene que
esperar a que terminen las transacciones que ya tienen la tabla tomada — y
**mientras espera, se pone en la cola de locks y todas las consultas que
llegan después quedan detrás de él**. Un `ALTER` de 1 ms atrás de un reporte
de 30 segundos **frena la tabla 30 segundos para todo el mundo**.

Lo que se le pone adelante:

```sql
SET lock_timeout = '3s';      -- si no consigo el lock rápido, fallo
ALTER TABLE usuarios ...;      -- y el deploy lo reintenta
```

Fallar rápido y reintentar es infinitamente mejor que bloquear la tabla. Es
la línea que separa una migración profesional de una que causa un incidente.

### D2 — Sistema de auditoría, 200M eventos/mes, 7 años

**Los números primero** (módulo 01): `200M × 12 × 7 = **16.800 millones de
filas**`. A ~300 bytes: **~5 TB**, más índices. Eso **no** es una tabla de
Postgres.

**Arquitectura por temperatura**, que es la clave de la respuesta:

```
CALIENTE (0-3 meses, ~600M filas)   Postgres particionado por mes
                                     Consultas interactivas del producto
TIBIO    (3-12 meses)                Particiones en Postgres, quizá en
                                     tablespace más barato. Se consultan poco
FRÍO     (1-7 años, ~16.000M filas)  S3 en Parquet, particionado por
                                     año/mes/día. Athena cuando alguien
                                     pregunta. Centavos por TB/mes
```

**Particionado: `PARTITION BY RANGE (created_at)`, mensual.** Por qué esa
columna y no `user_id`:

1. La consulta principal filtra por **últimos 30 días** → *partition pruning*:
   toca 1 o 2 particiones en vez de todas.
2. **La retención se vuelve `DROP TABLE`**, que es instantáneo. Con una tabla
   única, borrar 200M filas viejas es un `DELETE` de horas que genera bloat
   masivo.
3. El archivado a S3 es "exportá esta partición" en vez de un `SELECT` con
   rango sobre una tabla gigante.
4. Cada partición tiene su propio índice, chico y caliente en RAM
   (la solución a B4 del módulo 03).

**Índices**, uno por partición:

```sql
(user_id, created_at DESC)      -- la consulta principal
BRIN (created_at)               -- casi gratis: la tabla es append-only y
                                -- por lo tanto está físicamente ordenada por
                                -- fecha. Un BRIN ocupa KB donde un B-tree
                                -- ocuparía GB
```

Y **pocos índices**: es una tabla de escritura intensiva (200M/mes ≈ 77
inserts/s sostenidos, con picos), y cada índice es una escritura más (A3).

**Qué motor.** Postgres alcanza para lo caliente **porque la consulta es un
point lookup por usuario**, no una agregación. Si además hubiera que responder
*"cuántas acciones de tipo X por día en el último año, agrupadas por país"*,
ahí sí **ClickHouse** para la capa analítica — pero no reemplaza a Postgres,
lo complementa.

**Y la parte difícil: el borrado por GDPR.**

Es donde se gana esta pregunta, porque hay una tensión real: **la retención de
7 años suele ser una obligación legal, y el derecho al borrado también es
legal.** No se resuelven peleando; se resuelven separando **el dato** de **la
identidad**.

1. **Crypto-shredding — la respuesta.** Los campos con datos personales se
   guardan **cifrados con una clave por usuario**, y las claves viven en un
   KMS aparte. Borrar a un usuario es **borrar su clave**: los 16.000 millones
   de filas quedan intactas y los datos de esa persona son irrecuperables,
   sin reescribir ni un byte de S3 ni tocar una partición. Es **la** técnica
   para logs inmutables y append-only, y decirla por nombre marca la
   diferencia.
2. **No meter datos personales en el log de auditoría, de entrada.** Guardá
   `user_id` y un código de acción, no el email, el nombre ni el payload
   completo. Los datos personales viven en la tabla `usuarios`, que sí se
   puede borrar. **La mitad de los problemas de GDPR se evitan en el diseño
   del esquema, no en el procedimiento de borrado.**
3. **Pseudonimización** como posición legal: si el evento de auditoría queda
   con un identificador opaco y sin capacidad de reidentificación, en muchos
   marcos deja de ser dato personal.

Lo que **no** hay que proponer: un `DELETE ... WHERE user_id = ?` sobre 7 años
de particiones y sobre Parquet en S3. Los objetos de S3 son inmutables —
"borrar una fila" significa **reescribir el archivo entero**, y con miles de
archivos por año es un proceso de días que además rompe la inmutabilidad que
hacía confiable a la auditoría.

> **Rúbrica bloque D**
> - **Mid:** conoce `CREATE INDEX CONCURRENTLY` y propone particionar.
> - **Senior:** ordena los pasos con sus deploys, hace el backfill por lotes,
>   y separa caliente de frío con números.
> - **Staff:** usa el `CHECK NOT VALID` para evitar el escaneo, pone
>   `lock_timeout` adelante de cada `ALTER`, y resuelve GDPR con
>   crypto-shredding en vez de pelear con la inmutabilidad.

---

## Fuentes para profundizar

- **Martin Kleppmann**, *Designing Data-Intensive Applications*, caps. 3
  (almacenamiento e índices), 7 (transacciones) y 9 (consistencia). El
  capítulo 7 es la mejor explicación escrita de write skew.
- **Postgres**, *Transaction Isolation*:
  <https://www.postgresql.org/docs/current/transaction-iso.html>
- **Use The Index, Luke** — por qué el orden de las columnas es todo:
  <https://use-the-index-luke.com/sql/where-clause/the-equals-operator/concatenated-keys>
- **Postgres Wiki**, *Don't Do This*:
  <https://wiki.postgresql.org/wiki/Don%27t_Do_This>
- **Strong Migrations** — catálogo de qué operación bloquea:
  <https://github.com/ankane/strong_migrations#checks>
- **Daniel Abadi**, PACELC:
  <https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf>
- **Stripe**, *Idempotent requests* — el contrato de `409` y las claves:
  <https://docs.stripe.com/api/idempotent_requests>

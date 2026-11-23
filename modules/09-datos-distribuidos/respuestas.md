# Respuestas modelo — Módulo 09

> Abrilo **después** de escribir las tuyas en `mis-respuestas/09.md`.

---

## Bloque A — Conceptos

### A1 — Un problema por patrón

El test de si lo entendés: nombrar el **problema**, no la solución.

| Patrón | El problema que resuelve |
|---|---|
| **Outbox** | No hay transacción entre tu base y el broker. O se guarda y no se publica, o se publica y no se guarda. |
| **Saga** | No hay transacción entre dos bases de datos distintas, y el 2PC no es una opción (bloquea y no tolera fallos). |
| **CQRS** | Un modelo de datos que sirve bien para escribir sirve mal para leer, y viceversa. |
| **Event Sourcing** | Un `UPDATE` destruye información: el estado actual no te dice cómo llegaste ahí. |

Lo que casi nadie dice y es lo que te diferencia: **son cuatro problemas
distintos y los cuatro patrones son independientes.** Podés tener outbox sin
saga, saga sin CQRS, CQRS sin event sourcing. El error de alcance más común
es creer que vienen en combo.

### A2 — ACD, no ACID

Falta la **I** de **aislamiento**.

Una transacción de base de datos te da aislamiento: mientras está abierta,
nadie ve sus escrituras intermedias. **Una saga no puede dárselo**, porque
cada paso **commitea de verdad en su propia base**. Esos commits son
visibles para todo el mundo apenas ocurren.

Entonces una saga en vuelo es un estado **parcialmente aplicado y
públicamente visible**. Las otras tres letras sí las tenés:

- **A**tomicidad — "eventual": o se completan todos los pasos, o se compensan
  todos. Pero no instantáneamente.
- **C**onsistencia — cada paso deja su propia base consistente.
- **D**urabilidad — cada paso commitea.

**Las tres anomalías:**

1. **Lost update** — la saga escribe algo, otro lo sobrescribe, y la
   compensación de la saga pisa el cambio del otro. Es la que `saga-anomalias.ts`
   mide en la anomalía 2: **44% de las correcciones del cliente perdidas**.
2. **Dirty read** — alguien lee un valor intermedio de la saga que después se
   compensa, y toma una decisión con un dato que nunca fue real. Anomalía 1
   del script: **2.606 ventas rechazadas por stock que nunca estuvo vendido**.
3. **Fuzzy / non-repeatable read** — la saga lee el mismo dato en el paso 1 y
   en el paso 4 y obtiene valores distintos, porque alguien lo cambió en el
   medio. Y decidió con el primero.

### A3 — Coreografía vs orquestación

**Coreografía:** no hay coordinador. Cada servicio escucha eventos y reacciona.
`orders` publica `PedidoCreado`, `payments` lo escucha y publica `PagoOk`,
`inventory` escucha eso y reserva.

**Orquestación:** hay un coordinador explícito que conoce todos los pasos y
los va invocando. Los servicios no se conocen entre sí.

**El criterio concreto, no "depende":**

> **¿Cuántos pasos tiene la saga, y cuántas ramas condicionales?**
>
> - **≤ 3 pasos, lineal, sin ramas** → coreografía. El acoplamiento es bajo y
>   no vale la pena un coordinador.
> - **≥ 4 pasos, o hay ramas, o hay timeouts por paso, o necesitás saber en
>   qué paso está** → orquestación.

El segundo criterio, que es el que te hace cambiar en producción:

> **¿Podés responder "¿en qué paso está la saga X?" con UNA query?**

Con orquestación, sí: `SELECT paso FROM saga_state WHERE id = ...`.
Con coreografía, tenés que leer N topics y reconstruirlo en tu cabeza. Y eso
a las 3 de la mañana, con un cliente esperando, es la diferencia entre 10
minutos y 3 horas. Es exactamente el problema de C4.

### A4 — Compensación ≠ rollback

Un **rollback** borra la historia: después del `ROLLBACK`, es como si nunca
hubiera pasado. Nadie vio nada.

Una **compensación** es una **operación nueva** que intenta producir un
efecto opuesto. La historia queda: pasaron las dos cosas.

**El ejemplo que se ve a ojo:** cobraste $50.000 a una tarjeta y después
compensás.

- **Rollback (no existe):** el cliente nunca vio nada en su resumen.
- **Compensación (lo real):** el cliente ve **dos** líneas en su resumen, un
  cargo de $50.000 y un reintegro de $50.000. Y si el cargo cruzó el cierre
  del mes, pagó intereses sobre un cargo que "no pasó". Y si era débito,
  estuvo 3 días sin esa plata.

Otros tres donde se ve igual de claro:

- **Un mail enviado** no se puede compensar. Podés mandar otro que diga
  "ignorá el anterior". El primero ya se leyó.
- **Un stock reservado y liberado** dejó, en el medio, a otro cliente sin
  poder comprar (anomalía 1 del script).
- **Un webhook disparado** a un sistema de terceros ya corrió del otro lado.

La consecuencia de diseño: **el paso irreversible va último.** Lo que no se
puede compensar no debe necesitar compensación.

### A5 — Contramedidas de Richardson

Las seis, con lo que sacrifica cada una:

1. **Semantic lock** — un flag de estado (`PENDIENTE_DE_PAGO`) que avisa "esto
   está en vuelo". Los demás lo ven y deciden qué hacer.
   **Sacrifica:** los demás tienen que manejar ese estado, así que el flag se
   filtra a todos los consumidores y a la UI. Y creás la posibilidad de un
   **deadlock lógico** si dos sagas se esperan. Necesita un timeout.
2. **Commutative updates** — diseñás las operaciones para que el orden no
   importe (`saldo += 100` en vez de `saldo = 1100`). La compensación es
   `saldo -= 100` y da igual quién escribió en el medio.
   **Sacrifica:** no sirve para todo. Un cambio de dirección no es conmutativo.
3. **Pessimistic view** — reordenás los pasos para que el dato sucio no sea
   visible en el orden peligroso.
   **Sacrifica:** flexibilidad de diseño; a veces el orden que necesitás por
   negocio es justo el otro.
4. **Reread value** — antes de escribir, releés y verificás que nadie lo
   cambió. Es el optimistic lock.
   **Sacrifica:** nada, prácticamente. Es la que más conviene por defecto, y
   es la que en `saga-anomalias.ts` lleva los lost updates de **8.797 a 0**.
5. **Version file** — registrás las operaciones recibidas y las reordenás para
   aplicarlas en el orden correcto, incluso si llegan al revés.
   **Sacrifica:** complejidad real; es un mini-event-sourcing por entidad.
6. **By value** — elegís la estrategia **según el riesgo del dato**: para un
   pago de $5 millones usás saga con contramedidas fuertes; para cambiar una
   preferencia de notificación, nada.
   **Sacrifica:** nada, pero no es una contramedida: es la regla para elegir
   cuánta contramedida aplicar.

Si te acordás **una sola**, que sea la 4. Si te acordás **dos**, 4 y 1.

### A6 — Qué es exactamente CQRS

CQRS es **una cosa sola**: **el modelo que usás para escribir no es el mismo
objeto que el modelo que usás para leer.** Nada más.

**No** es consistencia eventual. **No** es dos bases de datos. **No** es
Kafka. **No** es event sourcing. Todo eso son consecuencias de algunos
niveles, no la definición.

Sobre los casos del enunciado:

- **`OrdersQueryService` + `OrdersCommandService` sobre la misma tabla:**
  **nivel 1**. Separación de código, una sola base, cero consistencia
  eventual, cero infraestructura nueva. Y es donde el 80% de los equipos
  deberían quedarse: ya te da la mayor parte del beneficio real (claridad,
  tests más simples, DTOs de lectura que no arrastran la lógica de dominio).
- **La lectura va a una réplica:** **nivel 2**. Ahora sí hay consistencia
  eventual, pero chiquita y conocida: el lag de replicación del módulo 05, y
  se mitiga con lo del caso 07.

Lo importante de la escala: **el salto caro es del 3 al 4**, porque es donde
aparece una base distinta, un consumidor que puede atrasarse, y la necesidad
de reconstruir. Del 0 al 3 es casi gratis.

### A7 — Cuándo NO usar event sourcing

Guion de 2 minutos:

> "No lo usaría cuando el requisito real es **auditoría**, no modelado por
> eventos. Si lo que te piden es 'quiero saber quién cambió esto', una tabla
> de historial o un trigger te dan el 95% del beneficio por el 5% del costo,
> y nadie tiene que aprender un paradigma nuevo.
>
> Tampoco cuando el dominio es CRUD: entidades que se crean, se editan y se
> borran, donde el estado anterior no le interesa a nadie. Un catálogo de
> categorías con event sourcing es puro costo.
>
> Y sobre todo, no lo usaría si en el equipo nadie mantuvo un event store
> **más de dos años**, porque los dos costos grandes aparecen recién ahí y no
> el día 1. El día 1 es hermoso. El costo uno es que cargar un agregado es
> O(eventos del stream): con 400.000 eventos son 12 segundos, y los snapshots
> dejan de ser una optimización y pasan a ser parte del diseño. El costo dos,
> que es el que de verdad duele, es el versionado: los eventos son inmutables,
> así que cuando cambia el esquema no podés migrarlos — tenés que escribir un
> upcaster, y los upcasters se apilan. Con 2 cambios de esquema por año, en el
> año 5 una reconstrucción completa pasa de 8 minutos a una hora, y el costo
> **por evento** sube de 30 a 46 microsegundos. Eso es código que no se borra
> nunca.
>
> Y hay una trampa más fina: los snapshots. Un snapshot es el resultado de
> correr `aplicar()` con el código de ese momento. Si arreglás un bug en
> `aplicar()` — que es justo lo que event sourcing te promete que podés hacer
> — los snapshots viejos siguen con el estado mal calculado. Hay que versionar
> los snapshots y descartarlos, y eso no viene en ningún tutorial.
>
> Donde sí lo usaría: cuando la historia **es** el dominio. Contabilidad,
> libro mayor, límites de crédito, cualquier cosa donde el estado actual ya lo
> modelabas como la suma de los movimientos. Ahí event sourcing no es un costo
> extra: es el modelo que ya tenías, escrito honestamente.
>
> Y la decisión es **por agregado, no por sistema**: Pago con event sourcing y
> Categoría como CRUD, en el mismo servicio, es lo normal y lo correcto."

### A8 — `PRIMARY KEY (stream_id, version)`

Es **optimistic locking**, el mismo patrón que el `fencing token` del
módulo 06.

El flujo de una escritura en un event store:

```
1. leo el stream        -> última version = 47
2. decido (lógica de dominio)
3. INSERT ... version = 48
```

Si entre 1 y 3 **otro proceso** escribió la versión 48, mi `INSERT` **falla
con violación de unicidad**. No se corrompe nada: reintento desde el paso 1,
releyendo el estado nuevo.

Eso te da, sin agregar nada:

- **Control de concurrencia sin locks** — no hay `SELECT FOR UPDATE`, no hay
  Redis, no hay Redlock. Y por eso no tiene el problema que Kleppmann le
  encuentra a Redlock (módulo 06): la garantía la da el **storage**, no un
  reloj.
- **Protección contra el proceso zombi** — el pod que se congeló 30 segundos y
  revive creyendo que todavía manda, al escribir falla. Exactamente el
  escenario que el fencing token resuelve, y acá sale gratis.

Es, honestamente, la propiedad más linda de event sourcing, y la que menos se
menciona.

### A9 — Un snapshot que se vuelve incorrecto

Porque **un snapshot no es un dato: es un cálculo cacheado.**

```
snapshot = aplicar(aplicar(aplicar(estadoInicial, e1), e2), ...)
                      ^^^^^^^ con el código de ESE día
```

Los eventos son inmutables y siguen siendo correctos. Lo que cambió es
`aplicar()`. Y arreglar un bug en `aplicar()` es justamente una de las cosas
que event sourcing promete que podés hacer impunemente, porque "recalculás
desde los eventos".

Pero si hay snapshots, **no recalculás desde los eventos**: arrancás del
snapshot, que tiene el estado **mal calculado** congelado, y le aplicás sólo
la cola. El bug sobrevive al fix, y el agregado nunca se recupera.

**La defensa:**

```ts
interface Snapshot {
  streamId: string;
  version: number;
  estado: unknown;
  logicaVersion: number;  // <- la versión del código de aplicar()
}

// al leer:
if (snap.logicaVersion !== LOGICA_VERSION_ACTUAL) {
  // descartar y recalcular desde el evento 0
}
```

Y `LOGICA_VERSION_ACTUAL` sube **en el mismo commit** en que cambiás
`aplicar()`. Si no está automatizado, alguien se va a olvidar.

Nota de capacidad, que es la parte que la gente no piensa: el día que subís
esa versión, **todos** los agregados se recalculan desde cero a la vez. Si
tenés agregados de 400.000 eventos, ese deploy es un incidente. Por eso en
sistemas grandes se regeneran los snapshots en batch **antes** de activar la
lógica nueva.

### A10 — Los cuatro desde el día 1

> "Son cuatro problemas distintos, y vos todavía no tenés ninguno de los
> cuatro. Outbox resuelve el dual write, saga resuelve que no hay transacción
> entre dos bases, CQRS resuelve que un modelo de escritura lee mal, y event
> sourcing resuelve que el `UPDATE` destruye información. Si no podés señalar
> cuál de esos cuatro problemas tenemos hoy, adoptar el patrón no es
> prevención: es deuda técnica anticipada.
>
> El costo de agregarlos después es bajo: outbox son dos tablas y un worker,
> y saga se introduce cuando aparece el segundo servicio que participa en una
> operación. El costo de tenerlos desde el día 1 es alto y permanente: cada
> bug tarda el triple en diagnosticarse porque hay cinco saltos asincrónicos
> entre la causa y el síntoma, y nadie puede razonar sobre el sistema.
>
> El orden que sí: 1) monolito modular con transacciones de verdad; 2) outbox
> cuando el primer `UPDATE` + `publish` tenga que ser atómico; 3) idempotencia
> en todo consumidor, siempre, desde el principio — esa sí es gratis y es
> obligatoria; 4) saga cuando haya una operación que cruce dos bases; 5) CQRS
> nivel 1 o 2 cuando una query duela de verdad, medida; 6) event sourcing sólo
> si un agregado específico tiene la historia como dominio.
>
> Fijate que el único que sí conviene desde el día 1 es la idempotencia, y es
> el que nunca está en la lista."

---

## Bloque B — Números

### B1 — Snapshots

**(a) De dónde sale 1.640.**

```
costo = seek + eventos × (traer_fila + deserializar)
 50 ms = 0,8 ms + N × (0,012 + 0,018) ms
 N = (50 - 0,8) / 0,03 = 1.640 eventos
```

El número exacto depende de tu hardware, de si los eventos están en caché y
de cuánto pesa tu `aplicar()`. **El orden de magnitud no:** son miles, no
cientos de miles. Y lo que importa es que la relación es **lineal en la
cantidad de eventos del stream**, así que crece para siempre.

**(b) 400.000 eventos, presupuesto de 20 ms.**

Por el **peor** caso, que es leer justo antes de que se tome el próximo
snapshot (la cola mide K completo, no K/2):

```
20 ms = 1,05 ms + K × 0,03 ms
K = (20 - 1,05) / 0,03 = 631 eventos
```

Entonces **snapshot cada 500** (el redondeo hacia abajo, con margen):

- peor caso: `1,05 + 500 × 0,03` = **16,1 ms** ✅
- promedio: `1,05 + 250 × 0,03` = **8,6 ms**

Si lo hubieras dimensionado por el promedio (`K = 631`), el peor caso serían
**20 ms exactos**, sin margen: cualquier variación del hardware y te comés el
presupuesto. **Los intervalos de snapshot se eligen por el peor caso**, igual
que los pools y los timeouts.

**(c) Tres años más a 1.000 eventos/día.**

```
400.000 + 3 × 365 × 1.000 = 1.495.000 eventos
```

- **Con snapshots cada 500:** el costo **no cambia**. Sigue en 16,1 ms peor
  caso. Es la propiedad entera de los snapshots: convierten un costo
  `O(historia)` en `O(K)`. Da igual si el stream tiene 3.500 o 5 millones.
- **Sin snapshots:** `1.495.000 × 0,03` = **44,8 segundos** para cargar un
  agregado. No es "lento": es un sistema que no funciona. Y el deterioro es
  gradual, así que te enterás cuando ya está en producción desde hace un año.

Lo que hay que llevarse: **un stream sin cota de crecimiento necesita
snapshots, o un diseño de agregado distinto.** Si el stream crece para
siempre (un sensor, un libro mayor que nunca cierra), la otra salida es
**cerrar el stream periódicamente**: `cuenta-123-2026` arranca con un evento
`SaldoInicial` que es el cierre del año anterior. Es exactamente lo que hace
la contabilidad de verdad desde hace 500 años.

### B2 — Lag de proyección

**(a) Refetch inmediato: el 100%.**

No es "casi todos": es **todos**. El POST volvió, el front dispara el GET en
el mismo tick, y la proyección en el mejor de los casos va a tardar 60 ms.
Ninguna lectura inmediata ve su escritura. **Nunca.**

Y esto es lo que hace que CQRS nivel 4 se sienta roto el primer día: el patrón
de front más común que existe (POST, después `invalidateQueries`) falla el
100% de las veces. No es un caso borde: es el caso normal.

**(b) Esperando 1 segundo: ~9,6%.**

Mejora muchísimo, y **sigue siendo inaceptable**: a 300 escrituras/s son **29
usuarios por segundo** viendo que su trabajo no se guardó. Y `setTimeout(1000)`
antes de refrescar es una solución que se siente mal, no funciona, y hace la
app más lenta para todos. Es el peor de los tres mundos.

La solución de costo cero es **(1)**: que el POST devuelva el recurso y el
front lo use (`setQueryData`, no `invalidateQueries`). Eso resuelve el caso del
100% sin tocar nada de infraestructura.

**(c) Por qué el p99 es un orden de magnitud peor.**

Una réplica de lectura es **un** salto: el WAL del primario a la réplica, en
la misma VPC, sobre una conexión que ya está abierta.

Una proyección son **cinco**, y cada uno tiene su propia latencia **y su
propia cola**:

```
1. commit del comando en Postgres
2. el publisher del outbox lo levanta        <- intervalo de polling
3. el broker lo acepta y lo replica          <- acks, min.insync.replicas
4. el consumer lo trae en un poll            <- max.poll.records, lote
5. el consumer lo procesa y commitea offset  <- escritura en Elasticsearch
```

Y la clave es que **el p99 de la suma es peor que la suma de los p99 típicos**,
porque los pasos 2 y 4 son **procesos por lotes**: si tu publisher corre cada
500 ms, el lag mínimo ya es 250 ms en promedio y 500 ms en el peor caso, sin
que nada esté mal.

Peor todavía: el paso 4 tiene **rebalances** (módulo 07). Un rebalance de 10
segundos no es un fallo, es operación normal — y durante esos 10 segundos el
lag de la proyección es de 10 segundos para **todas** las particiones que se
movieron. Eso es el p99.9 de 199 segundos que mide `cqrs-lag.ts`.

### B3 — La cadena de upcasters

**(a) Los saltos del año 5.**

Un evento escrito en el año `k` tiene que pasar por los cambios de esquema de
los años `k` a 5, o sea `2 × (5 - k)` saltos:

| año de escritura | eventos | saltos c/u | total |
|---|---|---|---|
| 1 | 16.000.000 | 8 | 128.000.000 |
| 2 | 16.000.000 | 6 | 96.000.000 |
| 3 | 16.000.000 | 4 | 64.000.000 |
| 4 | 16.000.000 | 2 | 32.000.000 |
| 5 | 16.000.000 | 0 | 0 |
| | | | **320.000.000** |

O directo: `16M × 2 × (4+3+2+1+0)` = `32M × 10` = **320.000.000 saltos** para
leer 80.000.000 de eventos. **Cuatro upcasts por evento, en promedio.**

**(b) Por qué crece cuadrático.**

Porque cada año nuevo hace **dos** cosas a la vez:

1. agrega eventos nuevos (el término lineal: `año × 16M`)
2. agrega 2 saltos a **todos los eventos que ya existían** (el término
   cuadrático: la sumatoria `1+2+...+n`, que es `n²/2`)

La prueba está en la última columna del script: el costo **por evento** sube
de **30 µs en el año 1 a 46 µs en el año 5**. No es que haya más eventos: es
que cada evento individual se volvió más caro de leer. Eso es lo que no se ve
en ningún benchmark del día 1, porque el día 1 hay una sola versión de
esquema y cero upcasters.

**(c) Que esa hora no sea una hora de downtime.**

**Nunca truncás la tabla que está sirviendo tráfico.** Se reconstruye en
verde, y es exactamente la misma técnica de la migración del caso 09:

```
1. creás pedidos_proyeccion_v2 al lado, vacía
2. un worker nuevo la alimenta desde el evento 0
   (el worker viejo sigue alimentando v1, que sigue sirviendo las queries)
3. esperás a que v2 alcance la punta del log  <- métrica: lag de v2
4. verificás: contás filas, comparás una muestra contra v1
5. cambiás a qué tabla lee la query (un flag, no un deploy)
6. v1 queda ahí una semana por si hay que volver
```

Durante la hora, **el usuario no nota nada**: v1 sigue sirviendo con su lag
normal. El flag del paso 5 es lo que te deja volver en 10 segundos en vez de
en una hora.

Las tres cosas que lo hacen más rápido, si una hora es demasiado:

- **paralelizar por partición** — N workers, cada uno con un rango de
  `stream_id`. Escala casi lineal si la proyección no tiene agregados
  globales.
- **upcastear al escribir, no al leer** — una migración de una sola vez que
  reescribe los eventos viejos en su versión actual (la salida 2 del script),
  si tu dominio te lo permite.
- **medir y reducir el costo del `aplicar()`** — en el modelo, deserializar es
  el 60% del costo por evento. Un formato binario en vez de JSON es un 2-3x.

Y la práctica que vale más que las tres: **reconstruir la proyección completa
una vez por mes, en staging, con los datos de producción.** Así el número de
la última columna es un número que conocés, y no una sorpresa el día que lo
necesitás.

### B4 — La saga de 4 pasos

**(a) Cuántas compensan.**

```
P(todos los pasos OK) = 0,999^4 = 0,996006
P(alguno falla)       = 0,399%
1.000 sagas/día × 0,399% ≈ 4 sagas/día
```

**Cuatro por día. Es decir: 1.460 por año.** Y acá está el punto que la mayoría
pasa por alto: **la ruta de compensación no es un caso raro, es tráfico de
producción.** Si tu compensación nunca se probó, tenés 4 bugs por día en un
código que nadie mira.

La regla práctica: **todo camino de compensación necesita un test de
integración propio**, igual que el camino feliz. Y una métrica con alerta:
`sagas_compensadas_total` por tipo de saga.

**(b) Si la compensación del paso 2 falla.**

El sistema queda en un estado **inconsistente que ningún código puede
arreglar solo**. Es el peor estado posible de una saga, y hay que diseñarlo
explícitamente:

1. **La compensación se reintenta.** Es lo primero, y por eso **toda
   compensación tiene que ser idempotente** (módulo 06): la vas a ejecutar N
   veces. Con backoff y jitter (módulo 08).
2. **Si agota los reintentos, la saga va a un estado terminal
   `COMPENSACION_FALLIDA`.** No a `FALLIDA`, que es distinto: `FALLIDA`
   significa "se deshizo todo"; `COMPENSACION_FALLIDA` significa "quedó plata
   en el aire".
3. **Alerta de severidad alta, con el `sagaId`.** No un log: una alerta que
   despierta a alguien.
4. **Lo arregla una persona**, con una herramienta interna: una pantalla que
   lista las sagas en `COMPENSACION_FALLIDA`, muestra qué pasos se ejecutaron
   y permite reintentar la compensación o marcarla como resuelta
   manualmente, con quién y por qué.

Ese paso 4 es el que **nunca** está en los tutoriales y es obligatorio en
producción. Si no tenés la pantalla, el "alguien" va a ser vos con un `UPDATE`
a mano en la base a las 3 de la mañana, sin auditoría y sin red.

Y hay un quinto que corresponde al negocio: **a veces la respuesta correcta
es no compensar**. Si el cobro salió y el envío es imposible, puede ser más
barato (y mejor para el cliente) dejar el cobro y mandar un producto
equivalente, en vez de deshacer. Esa decisión es de producto, no de
ingeniería, y conviene tenerla acordada **antes** del incidente. Está
desarrollado en el caso 03.

**(c) Por qué el último paso no debería necesitar compensación.**

Porque si el último paso tiene éxito, **la saga terminó**: no hay nada
después que pueda fallar y forzar su compensación. Y si falla, no hizo nada
que haya que deshacer.

Así que **los pasos se ordenan de más reversible a menos reversible**, y el
irreversible va al final:

```
❌ MAL:  1. cobrar (irreversible-ish)
         2. reservar stock
         3. mandar mail de confirmación (IRREVERSIBLE)
         4. generar la factura
         -> si 4 falla, tenés que "compensar" un mail ya leído

✅ BIEN: 1. reservar stock      (compensable: liberar)
         2. autorizar el pago   (compensable: anular la autorización)
         3. generar la factura  (compensable: nota de crédito)
         4. capturar el pago y mandar el mail  <- irreversible, ÚLTIMO
```

En pagos esto tiene un nombre y es exactamente este patrón:
**autorizar** (reversible, se cae solo en 7 días si no la capturás) y
**capturar** (irreversible). Autorizás temprano, capturás último. La industria
entera de tarjetas está diseñada alrededor de esta distinción, y es el mejor
ejemplo de que ordenar los pasos de una saga **es** el diseño.

---

## Bloque C — Diseño

### C1 — Alta de pedido con 3 servicios

**(a) Orquestación.**

Por el criterio de A3: son 4 pasos (crear, reservar, cobrar, confirmar), hay
ramas (si no hay stock no se cobra; si el pago falla se libera el stock), hay
timeouts por paso (el gateway de pagos puede tardar 30 s), y sobre todo:
**atención al cliente va a preguntar "¿en qué está el pedido 8821?" todos los
días.** Con coreografía, eso se contesta leyendo 3 topics.

El orquestador vive en `orders`, que es el dueño del caso de uso. **No** un
servicio `saga-orchestrator` nuevo: eso es un servicio sin dominio, y termina
siendo el que conoce las reglas de todos los demás.

**(b) Pasos y compensaciones.**

| # | paso | servicio | compensación | idempotente por |
|---|---|---|---|---|
| 1 | `crearPedido(PENDIENTE)` | orders | `marcarCancelado` | el `pedidoId` (lo genera el cliente) |
| 2 | `reservarStock` | inventory | `liberarStock` | `pedidoId` |
| 3 | `autorizarPago` | payments | `anularAutorizacion` | `pedidoId` |
| 4 | `capturarPago` + `confirmarPedido` | payments + orders | — (último, irreversible) | `pedidoId` |

Ordenado según B4(c): el irreversible último. Y fijate que el paso 1 es local
al orquestador, así que no necesita saga: es la transacción que **crea** la
saga.

```ts
// orders/saga/crear-pedido.saga.ts
// El estado vive en una tabla, no en memoria. Si el pod muere, otro sigue.
const PASOS = [
  { nombre: 'reservar_stock',  hacer: reservarStock,  deshacer: liberarStock },
  { nombre: 'autorizar_pago',  hacer: autorizarPago,  deshacer: anularAutorizacion },
  { nombre: 'capturar_pago',   hacer: capturarPago,   deshacer: null }, // último
];
```

**(c) Dónde entra el outbox, y cuántos hay.**

**Uno por servicio que publique eventos**, y por la regla de `outbox-cuando.md`:
*¿hay un `UPDATE` y un `publish` que tienen que ser atómicos?*

- **`orders`** → sí. `UPDATE pedido SET estado='CONFIRMADO'` + publicar
  `PedidoConfirmado` para el servicio de notificaciones y el de analytics.
  **Outbox.**
- **`inventory`** → sí. `UPDATE stock SET reservado = reservado + 1` + publicar
  `StockReservado`. **Outbox.**
- **`payments`** → sí, y es el más importante: `INSERT INTO cobro` + publicar
  `PagoCapturado`. Si esto no es atómico, cobraste plata que nadie sabe que
  cobraste.

**Tres outbox.** Y la parte que se confunde seguido (está en `outbox-brokers.md`
§1): **las llamadas de la saga en sí van por gRPC, sincrónicas.** El
orquestador necesita saber **ahora** si hay stock, para decidir el próximo
paso. El outbox es para los eventos que **notifican** al resto del mundo lo
que ya pasó, no para coordinar la saga.

Si en cambio hicieras la saga por eventos (coreografía), ahí cada paso de la
saga **sí** sale por el outbox. Es la diferencia de A3 vista desde la
infraestructura.

**(d) Idempotencia y con qué clave.**

En **dos lugares distintos**, y es el error más común confundirlos:

1. **En el borde** (`POST /pedidos`): clave de idempotencia **del cliente**
   (`Idempotency-Key`), para que el reintento del navegador o de la app móvil
   no cree dos pedidos. Alcance: `(clienteId, clave)`. TTL 24 h. Módulo 06.
2. **En cada paso de la saga**: clave `(pedidoId, nombreDelPaso)`. El
   orquestador va a reintentar `reservarStock` porque hubo un timeout
   ambiguo, y `inventory` tiene que reservar **una** vez. Esta clave la pone
   el orquestador, no el cliente, y **no expira mientras la saga esté viva**.
3. **En las compensaciones**, con la misma clave: `liberarStock` se va a
   ejecutar más de una vez (B4(b)).
4. **En los consumidores de los eventos del outbox**: tabla de inbox / dedup
   por `eventId`, porque el outbox es at-least-once por diseño.

Cuatro lugares, cuatro claves distintas. Si sólo tenés el (1), tenés un
sistema que duplica cobros con total elegancia.

**(e) `inventory` reservó, `payments` falló, y la compensación también falla.**

Es B4(b) con nombres propios. La salida:

```
1. liberarStock se reintenta con backoff+jitter: 1s, 2s, 4s, 8s, 16s
   (idempotente, así que reintentar es seguro)

2. agotados los reintentos:
   UPDATE saga_state SET estado = 'COMPENSACION_FALLIDA',
                         paso_fallido = 'liberar_stock'
   WHERE pedido_id = ...

3. alerta PagerDuty con el pedidoId, el sagaId y qué pasos corrieron
   (severidad alta: hay stock bloqueado que nadie puede vender)

4. el stock queda reservado para un pedido que nunca va a existir.
   Eso es inventario fantasma: afecta las ventas de OTROS clientes.
   -> por eso toda reserva tiene vencimiento:
      reservas con expires_at, y un job que libera las vencidas.
      Esa es la red de seguridad que hace que el paso 4 no sea un
      incidente de negocio, sino un ticket.

5. el pedido queda en estado CANCELADO para el cliente (eso sí funciona,
   es local a orders). El cliente no ve nada raro.
```

La lección de diseño: **la reserva con vencimiento convierte un fallo de
compensación en un fallo que se cura solo.** Es la mejor plata que vas a
gastar en este diseño, y vale para stock, para cupones, para asientos de
avión y para cualquier recurso que se "aparte".

Y es un ejemplo de contramedida de Richardson en estado puro: el `expires_at`
es un **semantic lock con timeout**.

### C2 — El `GET /pedidos` con 9 JOINs

**(a) Los niveles, con lo que ganás y lo que pagás.**

| salto | qué ganás | qué pagás |
|---|---|---|
| **0 → 1** (separar código) | claridad, DTOs de lectura sin lógica de dominio, tests más simples | nada. Literalmente nada. |
| **1 → 2** (leer de réplica) | sacás el 70% de la carga del primario — **es el salto con mejor relación costo/beneficio de los cinco** | consistencia eventual chica y conocida (lag de replicación, módulo 05); read-your-writes se rompe |
| **2 → 3** (vista materializada en la MISMA base, refrescada en la misma transacción) | la query de 2,8 s pasa a un `SELECT` por índice; **sin consistencia eventual**, porque se actualiza en la transacción de escritura | las escrituras se vuelven más lentas y más acopladas; más locks; la vista hay que mantenerla |
| **3 → 4** (base distinta: Elasticsearch, DynamoDB) | queries que la base relacional no puede hacer bien (full-text, agregaciones, geo); escala de lectura independiente | **el salto caro**: infraestructura nueva, consumidor que se atrasa, reconstrucción de 40 min, read-your-writes roto en serio (B2), un sistema más que monitorear y que puede estar caído |

**(b) Dónde me quedo: en el 3.**

Porque el problema enunciado es *"9 JOINs, 2,8 s, 70% de la carga"*. Ese es un
problema de **forma del modelo**, no de volumen ni de tipo de query. Una
vista materializada o una tabla desnormalizada mantenida en la misma
transacción lo resuelve entero, **y no introduce consistencia eventual**.

Y antes de eso, en orden, porque son más baratos todavía:

1. **`EXPLAIN ANALYZE`.** De 9 JOINs, lo normal es que 7 estén bien y uno
   esté haciendo un seq scan o perdiendo un índice por el orden de las
   columnas (módulo 05). Arreglar eso puede llevarte de 2,8 s a 200 ms sin
   tocar la arquitectura, y es el trabajo de una tarde.
2. **Caché en Redis con TTL corto** (módulo 04). Si el listado tolera 30
   segundos de desactualización, un hit rate del 90% te saca el 90% de la
   carga **hoy**, sin cambiar nada del modelo.
3. **Réplica de lectura** (nivel 2), que es cambiar una cadena de conexión.
4. **Recién ahí** la vista materializada.

El nivel 4 lo justificaría **sólo** si apareciera un requisito que Postgres
no puede dar bien: búsqueda full-text con ranking, facetas, o agregaciones
sobre decenas de millones de filas. "Es lento" no es ese requisito.

**(c) Si eligiera el nivel 4.**

En el front:

- **Ningún `invalidateQueries` después de un POST.** El comando devuelve el
  recurso y el front hace `setQueryData`. Esto no es una optimización: sin
  esto, el nivel 4 está roto el 100% de las veces (B2a).
- **Estados explícitos en la UI.** Un pedido recién creado se muestra como
  "procesando" hasta que llega la confirmación. La consistencia eventual pasa
  de ser un bug a ser información.
- **Nada de `setTimeout` antes de refrescar.** Es el peor de los tres mundos
  (B2b).

Los endpoints que necesitan read-your-writes, y son pocos:

- `GET /pedidos/:id` **inmediatamente después** del POST → sí. Y es simple,
  así que la mitigación 3 (leer del modelo de escritura por N segundos)
  alcanza: traer un pedido por id no necesita los 9 JOINs.
- `GET /pedidos` (el listado paginado y filtrado) → **no**. Y acá está la
  trampa: si quisieras read-your-writes **también** acá, tendrías que correr
  los 9 JOINs, que es exactamente lo que querías evitar. El listado se
  resuelve con UI optimista, no leyendo del modelo de escritura.
- `GET /pedidos/metricas` → no.

**Y es una decisión por endpoint.** Si la respuesta fuera "todos", el nivel 4
no es para este dominio.

### C3 — Límites de crédito

**(a) ¿Buen candidato? Sí, y es casi el ejemplo de manual.**

Chequeando contra la regla del script:

- ✅ **La historia es el dominio.** El límite actual no es un número que se
  edita: es el **resultado** de una secuencia de decisiones de riesgo,
  scorings y reclamos. Ya lo modelabas como una suma de ajustes.
- ✅ **Auditoría regulatoria como requisito explícito.** *"¿Por qué este
  cliente tenía este límite el 14 de marzo?"* es una pregunta que en event
  sourcing se contesta con `WHERE occurred_at <= '2026-03-14'` y en un CRUD
  no se contesta en absoluto — el `UPDATE` destruyó la información.
- ✅ **Preguntas futuras que hoy no sabés.** *"¿Cuántos clientes que subieron
  de límite por scoring automático terminaron en mora?"* El log la responde;
  una tabla con `UPDATE` requiere haber previsto la pregunta.
- ✅ **Corrección retroactiva.** *"El scoring de abril estaba mal calibrado,
  hay que recalcular"* es un `aplicar()` nuevo y una reconstrucción, no una
  migración de datos a mano.

El único reparo honesto, y hay que decirlo en la entrevista: **el volumen es
bajo**. Unos pocos eventos por cliente por año, así que los snapshots no van a
hacer falta en años — lo cual es bueno, porque el costo A desaparece y queda
sólo el costo B.

**(b) Eventos y agregado.**

Los eventos son **hechos del dominio en pasado**, con la causa adentro.
La regla: si el nombre del evento no le dice nada a alguien de riesgo, está
mal nombrado.

```ts
type EventoLimite =
  | { tipo: 'LimiteAsignadoInicialmente'; v: 1;
      montoCentavos: number; moneda: string; scoringId: string; politicaVersion: string }
  | { tipo: 'LimiteAjustadoPorScoring'; v: 1;
      montoAnteriorCentavos: number; montoNuevoCentavos: number;
      scoringId: string; modeloVersion: string; politicaVersion: string }
  | { tipo: 'LimiteAjustadoManualmente'; v: 1;
      montoAnteriorCentavos: number; montoNuevoCentavos: number;
      analistaId: string; motivo: string; ticketId: string }
  | { tipo: 'LimiteCongelado'; v: 1;
      motivo: 'MORA' | 'FRAUDE_SOSPECHADO' | 'PEDIDO_DEL_CLIENTE'; reclamoId?: string }
  | { tipo: 'LimiteDescongelado'; v: 1; analistaId: string; motivo: string }
  | { tipo: 'LimiteDadoDeBaja'; v: 1; motivo: string };
```

Cuatro decisiones de diseño que valen la entrevista:

1. **Centavos en entero, nunca float.** Y la moneda al lado. Un evento es
   inmutable: un error de representación acá es para siempre.
2. **`politicaVersion` y `modeloVersion` en el evento.** Sin eso, en dos años
   no podés explicar la decisión, que era el requisito original. El evento
   tiene que ser autosuficiente: no podés depender de que la tabla de
   políticas de 2026 todavía exista.
3. **El `v: 1` desde el primer día.** Si no está, el primer upcaster tiene que
   adivinar la versión por la forma del payload, y eso es un bug esperando.
4. **`montoAnterior` además de `montoNuevo`**, aunque sea redundante con el
   estado. Hace cada evento legible solo, sin reconstruir el agregado, que es
   lo que compliance necesita. La redundancia en un event store es barata; la
   ambigüedad no.

El agregado:

```ts
class LimiteDeCredito {
  limiteCentavos = 0;
  moneda = 'ARS';
  congelado = false;
  version = 0;

  aplicar(e: EventoLimite) {
    switch (e.tipo) {
      case 'LimiteAsignadoInicialmente':
        this.limiteCentavos = e.montoCentavos; this.moneda = e.moneda; break;
      case 'LimiteAjustadoPorScoring':
      case 'LimiteAjustadoManualmente':
        this.limiteCentavos = e.montoNuevoCentavos; break;
      case 'LimiteCongelado':   this.congelado = true;  break;
      case 'LimiteDescongelado': this.congelado = false; break;
      case 'LimiteDadoDeBaja':  this.limiteCentavos = 0; this.congelado = true; break;
    }
    this.version++;
  }

  // Las REGLAS viven acá, no en el handler. Devuelven eventos, no mutan.
  ajustarPorScoring(nuevo: number, scoringId: string, modelo: string): EventoLimite[] {
    if (this.congelado) throw new Error('limite congelado');
    if (nuevo === this.limiteCentavos) return [];   // <- no generar eventos vacíos
    return [{ tipo: 'LimiteAjustadoPorScoring', v: 1,
              montoAnteriorCentavos: this.limiteCentavos, montoNuevoCentavos: nuevo,
              scoringId, modeloVersion: modelo, politicaVersion: POLITICA_ACTUAL }];
  }
}
```

Lo del `return []` importa: un event store lleno de eventos que no cambian
nada hace que cada reconstrucción sea más cara por nada. **Un evento es un
cambio, no un intento.**

Y para la query de compliance, que es el requisito original:

```sql
-- "¿qué límite tenía el cliente 8821 el 14 de marzo, y por qué?"
SELECT version, tipo, payload, occurred_at
FROM eventos
WHERE stream_id = 'limite-8821' AND occurred_at <= '2026-03-14T23:59:59Z'
ORDER BY version;
```

Se reconstruye el agregado con esos eventos y **además** se muestra la lista:
el "por qué" sale del `motivo`, el `analistaId` y el `politicaVersion`. Eso es
lo que un CRUD no puede dar de ninguna manera.

**(c) Partir `LimiteAjustado` en `LimiteSubido` y `LimiteBajado`.**

Esto es exactamente el costo B del script, y el plan es el que hay que saber
de memoria porque es el día que event sourcing cobra:

```
0. PRIMERO: ¿hace falta? El esquema de un evento es tan permanente como una
   API pública. Si el motivo es estético, no se toca. Si el motivo es que
   las reglas de negocio ahora difieren de verdad entre subir y bajar
   (distintas aprobaciones, distintas notificaciones), sí se toca.

1. Los eventos nuevos se escriben con los tipos nuevos:
   LimiteSubido v1 / LimiteBajado v1.

2. Se escribe el upcaster, que es una función pura y se testea como tal:

     function upcast(e: EventoCrudo): EventoLimite {
       if (e.tipo === 'LimiteAjustadoPorScoring' && e.v === 1) {
         const subio = e.montoNuevoCentavos > e.montoAnteriorCentavos;
         return { ...e, tipo: subio ? 'LimiteSubido' : 'LimiteBajado', v: 1 };
       }
       return e;
     }

   ⚠️ Y acá está el bug que este cambio tiene escondido: ¿qué pasa con los
      eventos donde montoNuevo === montoAnterior? No son ni subida ni bajada.
      En el modelo nuevo no existen. Hay que decidir explícitamente qué
      hacer con ellos (descartarlos, o un tercer tipo), y esa decisión es
      del dominio. Partir un tipo de evento en dos SIEMPRE tiene un caso
      así, y encontrarlo es el trabajo real de la migración.

3. Test obligatorio: un fixture de CADA versión histórica del evento, con
   el estado esperado después de aplicarlo. Esos fixtures no se borran
   nunca. Un upcaster con un bug corrompe silenciosamente toda la historia
   anterior, en todas las proyecciones, para siempre.

4. aplicar() entiende los tipos nuevos. El viejo se elimina del switch,
   porque después del upcaster ya no llega nunca.

5. Se sube LOGICA_VERSION y se descartan los snapshots (A9).
   Con este volumen no importa; con volumen alto, se regeneran en batch
   ANTES de activar la lógica nueva.

6. Las proyecciones se reconstruyen en verde (B3c), no truncando en caliente.

7. El upcaster queda en el código PARA SIEMPRE, con un comentario que diga
   de qué fecha a qué fecha aplica y por qué existe. Es lo que convierte un
   `if` misterioso en documentación.
```

Lo que NO se hace: **un `UPDATE` sobre la tabla de eventos.** Eso rompe la
única propiedad por la que elegiste event sourcing, y si hay requisitos
regulatorios puede ser directamente ilegal.

**(d) Qué no hago con event sourcing.**

Casi todo lo demás, y decirlo es la mitad de la respuesta:

- **Los datos del cliente** (nombre, CUIT, domicilio) → CRUD con tabla de
  historial. La historia de un domicilio no es el dominio.
- **El catálogo de políticas de riesgo** → CRUD versionado. Es configuración.
- **Las proyecciones de lectura** (*"clientes con límite > X"*, el dashboard
  de riesgo) → tablas comunes alimentadas por los eventos. Son derivadas y
  descartables: **toda proyección tiene que poder tirarse y reconstruirse**.
- **El scoring en sí** → es un cálculo, no un agregado. El evento guarda el
  `scoringId` y el resultado; el modelo vive afuera.
- **Los logs de auditoría de acceso** (*"quién consultó este límite"*) → una
  tabla de append común, o el stack de observabilidad. No es el dominio del
  agregado.

Y la frase que cierra: **la decisión es por agregado.** `LimiteDeCredito` con
event sourcing y `Cliente` como CRUD, en el mismo servicio, es lo correcto.

### C4 — La saga de 6 pasos en coreografía que nadie puede operar

**Diagnóstico (lo que el síntoma te dice):**

El problema **no** es que use Kafka ni que sea coreografía. El problema es
que **no hay una representación explícita del estado de la saga**. El estado
está implícito y distribuido en 6 topics, así que:

1. **No se puede consultar.** *"¿En qué paso está la saga X?"* requiere leer
   6 topics y reconstruirlo mentalmente. A las 3 AM eso son horas.
2. **No se puede reanudar.** Nadie sabe qué paso falta, así que no hay nada
   que reintentar. Las sagas colgadas se quedan colgadas para siempre y se
   descubren cuando se queja un cliente.
3. **No hay timeouts por paso.** Un paso que nunca responde no genera ningún
   evento, y la ausencia de un evento no es un evento: **nadie se entera
   nunca**. Es el fallo más caro de este diseño.
4. **Las compensaciones están regadas.** Cada servicio compensa lo suyo
   cuando escucha un evento de fallo, así que no hay un lugar donde leer
   "cómo se deshace esta operación". El orden no está garantizado.
5. **El acoplamiento es peor que con orquestación, no mejor.** Cada servicio
   tiene que conocer los eventos de los demás para saber a qué reaccionar.
   Con 6 pasos eso es un grafo que nadie tiene en la cabeza.

Con 6 pasos, el criterio de A3 dice orquestación desde el principio. Este
sistema está del lado equivocado de la línea.

**Plan de migración, sin reescribir nada (y en este orden, que importa):**

**Paso 1 — Observabilidad primero, cambios después. (1 semana)**

Un consumidor nuevo, que no toca nada de lo existente, escuchando los 6
topics y escribiendo una tabla:

```sql
CREATE TABLE saga_observada (
  saga_id       text PRIMARY KEY,
  tipo          text NOT NULL,
  paso_actual   text NOT NULL,
  pasos_ok      jsonb NOT NULL DEFAULT '[]',
  iniciada_en   timestamptz NOT NULL,
  ultimo_evento timestamptz NOT NULL,
  estado        text NOT NULL  -- EN_CURSO | COMPLETADA | FALLIDA | COLGADA
);
```

Esto **solo** ya cambia la vida del equipo: contesta *"¿en qué paso está?"*
con una query, y permite el paso 2.

**Paso 2 — La alerta que hoy no existe. (días)**

```sql
SELECT saga_id, tipo, paso_actual, now() - ultimo_evento AS parada_hace
FROM saga_observada
WHERE estado = 'EN_CURSO' AND ultimo_evento < now() - interval '15 minutes';
```

Un job cada minuto y una alerta. **Esto convierte "nos enteramos cuando se
queja un cliente" en "nos enteramos en 15 minutos", y no tocó una sola línea
del flujo.** Es el mejor retorno del plan entero.

Y de paso te da el dato que no tenés: **cuántas sagas se cuelgan por día**.
Ese número es el que justifica el resto del trabajo ante el negocio.

**Paso 3 — Reanudación manual. (1-2 semanas)**

Una pantalla interna que lista las sagas colgadas, muestra los pasos que
corrieron, y tiene un botón por paso para re-emitir el evento que lo dispara.

Requisito: **los consumidores tienen que ser idempotentes** para que
re-emitir sea seguro. Si no lo son, eso es el trabajo real de este paso, y hay
que hacerlo igual — con o sin migración, un consumidor de Kafka no idempotente
es un bug (módulo 07).

**Paso 4 — Invertir el flujo, saga por saga. (por iteración)**

Acá la tabla `saga_observada` **pasa de observadora a dueña**. Y la clave es
que se hace **de a una saga, y de a un paso**, no con un big bang:

```
estado inicial:  orders -> (evento) -> payments -> (evento) -> inventory ...
                 la tabla sólo mira

paso a paso:     el orquestador lee la tabla y llama al paso 1 por gRPC
                 el resto sigue por eventos, y la tabla sigue observando
                 -> funciona igual, un paso menos de coreografía

repetís:         se va corriendo la frontera hasta que la tabla maneja todo
```

Entre cada iteración el sistema **funciona y está en producción**. Si una
iteración sale mal, volvés una sola. No hay un día de corte.

**Paso 5 — Lo que NO hay que hacer. (y es la mitad del valor de la respuesta)**

- ❌ **Reescribir en Temporal/Step Functions de entrada.** Tendrías dos
  sistemas conviviendo, sagas viejas en vuelo imposibles de migrar, y un
  equipo aprendiendo una herramienta nueva **durante** una migración. Cuando
  los pasos 1-4 estén hechos, la decisión de adoptar durable execution es
  fácil, barata y reversible — y puede que ya no haga falta.
- ❌ **Arrancar por el paso 4.** La tentación es ir directo a "lo correcto".
  Pero sin el paso 1 no podés verificar que la migración no rompió nada, y sin
  el paso 2 no sabés cuántas sagas se cuelgan hoy, o sea que no vas a poder
  demostrar la mejora.
- ❌ **Tocar los eventos existentes.** Los topics y sus esquemas se quedan como
  están; el orquestador los va reemplazando desde afuera.

**La frase que cierra la respuesta de entrevista:**

> "El problema no es la coreografía: es que el estado de la saga no está
> escrito en ningún lado. Antes de migrar nada, lo haría explícito en una
> tabla que sólo observa — y con eso solo el equipo ya puede contestar en qué
> paso está una saga y alertar cuando una se cuelga. Recién después invertiría
> el flujo, de a un paso por vez, con el sistema siempre andando."

---

## Bloque D — Tu stack

### D1 — `@nestjs/cqrs`

**En qué nivel te pone: en el 1.** Separación de código, nada más. Misma base,
misma transacción, cero consistencia eventual.

Y eso **está bien**: el nivel 1 es donde conviene estar. El problema es que el
nombre del paquete hace creer que estás haciendo algo más grande.

**Qué hace el `EventBus` si el proceso se cae entre el `commit()` y el handler:
nada. El evento se pierde.** Y esto es lo importante de entender:

```ts
// ESTE es el dual write del módulo 02, con un nombre más lindo.
await this.repo.save(pedido);          // commiteó en Postgres  ✅
this.eventBus.publish(new PedidoCreado(pedido.id));  // 💀 el pod muere acá
// el handler que manda el mail nunca corre. Nadie se enteró.
```

El `EventBus` de `@nestjs/cqrs` es **in-memory**: un `Subject` de RxJS en el
mismo proceso. No hay persistencia, no hay reintento, no hay confirmación,
no cruza pods. Es un patrón observer con inyección de dependencias.

Entonces:

- ✅ **Sirve** para desacoplar módulos **dentro** del mismo proceso, cuando
  perder el evento no tiene consecuencias: invalidar un caché local, emitir
  una métrica, loguear.
- ❌ **No sirve** para nada que tenga que pasar **seguro**: mandar un mail,
  actualizar una proyección, notificar a otro servicio, cobrar.

**Qué patrón falta: el outbox.** Y el arreglo es chico:

```ts
// el evento se guarda en la MISMA transacción que el cambio
await this.dataSource.transaction(async (m) => {
  await m.save(pedido);
  await m.insert(OutboxEvent, {
    tipo: 'PedidoCreado', payload: { id: pedido.id }, publicado: false,
  });
});
// un worker aparte lee la outbox y publica a Kafka (módulo 02)
```

El `AggregateRoot` de `@nestjs/cqrs` con `apply()` + `commit()` es un lugar
cómodo para hacerlo: en vez de que `commit()` empuje al `EventBus`,
`getUncommittedEvents()` se escribe a la outbox dentro de la transacción. Es
el mismo código del dominio con una infraestructura honesta debajo.

Y ojo con la otra trampa: `@nestjs/cqrs` tampoco te da ordenamiento ni
reintento. Si un handler lanza, el evento se perdió y nadie se enteró — ni
siquiera hay un log, salvo que lo pongas vos.

### D2 — El pod que muere entre el paso 3 y el 4

**(a) Quién reanuda y cómo se enteró.**

Nadie se "entera": **se descubre por polling**. Y esto es clave, porque la
intuición dice que tiene que haber una notificación, y no la hay — el pod que
murió no pudo avisar nada.

```ts
// un job en cada pod, cada 30 s
@Cron('*/30 * * * * *')
async reanudarSagasColgadas() {
  const sagas = await this.db.query(`
    SELECT * FROM saga_state
    WHERE estado = 'EN_CURSO'
      AND lease_hasta < now()      -- el lease del pod muerto venció
    ORDER BY lease_hasta
    LIMIT 10
    FOR UPDATE SKIP LOCKED          -- módulo 02: varios pods, sin pisarse
  `);
  for (const s of sagas) await this.continuar(s);
}
```

Las tres piezas:

1. **`lease_hasta`** — el pod que trabaja en la saga renueva su lease cada
   10 s. Si murió, en 30 s el lease vence y la saga queda disponible. **El
   tiempo de detección es el lease, y es una decisión de diseño**: 30 s para
   un pedido, 5 s para algo urgente, 5 min si los pasos son caros.
2. **`FOR UPDATE SKIP LOCKED`** — el mismo patrón del outbox del módulo 02.
   Varios pods pueden correr el job a la vez sin tomar la misma saga.
3. **Idempotencia de cada paso** — porque el pod muerto pudo haber ejecutado
   el paso 4 y muerto **antes** de escribir que lo hizo. El timeout ambiguo
   del módulo 06, otra vez: no se puede saber si el paso corrió. Entonces el
   que reanuda lo ejecuta de nuevo, y el paso tiene que ser idempotente por
   `(sagaId, paso)`. **Si tus pasos no son idempotentes, no tenés
   reanudación: tenés duplicación.**

Y el `@Cron()` acá es el del módulo 03: corre en los 4 pods, y está **bien**
que corra en todos, porque `SKIP LOCKED` lo hace seguro. No necesitás lock
distribuido, y eso es el patrón correcto, no una concesión.

**(b) Si dos pods la reanudan al mismo tiempo.**

En condiciones normales no pasa: `FOR UPDATE SKIP LOCKED` lo impide.

Pero **puede pasar igual**, y hay que diseñar para eso: el pod A toma la saga,
se congela 40 segundos (GC pause, el nodo se queda sin CPU, la VM se
suspende), el lease vence, el pod B la toma, y entonces A revive creyendo que
todavía la tiene. Es el **proceso zombi** del módulo 06, y ningún lease lo
puede evitar — es el argumento central de Kleppmann contra Redlock.

Las dos defensas, y hacen falta las dos:

1. **Fencing token.** El `lease` lleva un número que sube cada vez que se
   toma la saga. Toda escritura verifica que su token sea el actual:

   ```sql
   UPDATE saga_state
      SET paso_actual = 'capturar_pago', lease_version = lease_version
    WHERE saga_id = $1 AND lease_version = $2;   -- $2 = el token de ESTE pod
   -- 0 filas afectadas -> soy un zombi, abandono sin hacer nada
   ```

   Es el mismo optimistic lock de A8 y del módulo 06. **La garantía la da
   Postgres, no el reloj.**

2. **Idempotencia del paso.** Si A alcanzó a llamar `capturarPago` antes del
   fencing, la clave `(sagaId, 'capturar_pago')` hace que el segundo cobro no
   exista. Esta es la defensa que de verdad protege la plata: el fencing
   protege el **estado de la saga**, la idempotencia protege el **efecto**.

**(c) Qué te da Temporal / Step Functions, y qué perdés.**

Lo que te dan, y es más de lo que parece:

- **El estado y los reintentos son del runtime.** No escribís `saga_state`, ni
  el lease, ni el job de reanudación, ni el `SKIP LOCKED`. Todo eso —que es
  (a) y (b) completos— ya está, probado, por gente que lo hizo mil veces.
- **Timers durables.** *"Si el pago no se confirma en 24 h, cancelar"* es una
  línea (`await sleep('24h')`), y sobrevive deploys, reinicios y caídas. Sin
  esto, un timeout de 24 h es una tabla, un job y tres bugs.
- **Reintentos con política declarativa** por actividad, con backoff y
  jitter, sin escribirlos.
- **Visibilidad gratis.** La UI te muestra en qué paso está cada ejecución,
  qué falló, con qué input y qué output. Es la respuesta entera de C4 sin
  construir nada.
- **El código se lee como el flujo.** La saga es una función con `await` y
  `try/catch`, no una máquina de estados dispersa en handlers:

  ```ts
  // se LEE como código secuencial, y es durable
  const reserva = await reservarStock(pedido);
  try {
    const auth = await autorizarPago(pedido);
    await sleep('2h');                  // sobrevive un deploy
    await capturarPago(auth);
  } catch (e) {
    await liberarStock(reserva);        // la compensación, en el catch
    throw e;
  }
  ```

Lo que perdés, y hay que decirlo porque es lo que separa una respuesta de
entrevista de un folleto:

- **Un servicio más que operar** (en Temporal self-hosted: un cluster, con
  Cassandra o Postgres detrás, y su propio escalado). Temporal Cloud lo evita,
  y cuesta plata.
- **El código deja de ser JavaScript normal.** El workflow tiene que ser
  **determinístico**: nada de `Date.now()`, `Math.random()`, `fetch` ni leer
  variables de entorno dentro del workflow — todo eso va en una actividad.
  Esa restricción es sutil y el equipo la va a violar al principio, con bugs
  raros de replay.
- **Versionado de workflows.** Un workflow que lleva 3 días corriendo y
  desplegás una versión nueva: Temporal tiene herramientas, y es un tema que
  hay que aprender. Es el mismo problema de versionado del event sourcing,
  con otra cara.
- **Lock-in real.** La lógica de orquestación queda escrita contra el SDK.
- **Testing y debugging distintos.** No es un `jest` común; hay que aprender
  el test environment y el replay.

**El criterio para decidir, concreto:**

> **¿Cuántas sagas distintas tenés, y cuántas van a ser?**
>
> - **1 o 2 sagas** → tu tabla con lease está bien. Adoptar un motor de
>   workflows para una saga es infraestructura buscando un problema.
> - **5 o más, o aparecen timers largos (horas, días), o ya escribiste el
>   lease y el job de reanudación dos veces** → el motor se paga solo. Ese
>   "dos veces" es la señal más confiable: cuando lo estás reescribiendo,
>   dejó de ser accidental.

### D3 — El agente de IA con 7 herramientas

**(a) ¿Es una saga? Sí, y es el ejemplo más limpio que vas a encontrar.**

Tiene las tres propiedades: pasos que **commitean efectos reales e
independientes** (dos cobran dinero), **sin transacción global** posible, y
**compensaciones semánticas** (no rollbacks: el cobro ya está en el resumen
del cliente).

Y tiene una propiedad que la hace **más difícil** que una saga clásica, que es
lo que hay que nombrar: **el conjunto de pasos no está predefinido.** El LLM
decide en el paso 4 qué va a hacer en el paso 5. No tenés el array de `PASOS`
de C1. Es una saga cuyo plan se descubre mientras se ejecuta.

Las compensaciones, por tipo de herramienta:

| herramienta | compensación |
|---|---|
| lectura / búsqueda | **ninguna**: no tiene efecto. No hace falta compensarla, pero **sí** cachearla (ver (b)). |
| cobro | reintegro o anulación de la autorización — con su propio ID de idempotencia |
| mandar mail / mensaje | **no se puede**: mensaje de seguimiento. **Va último.** |
| crear un recurso externo | borrarlo o marcarlo cancelado |
| llamada a la API de un tercero sin reversa | **no se puede**: va último, o requiere aprobación humana antes |

Y por la regla de B4(c): **las herramientas irreversibles van al final del
plan, y si el LLM las pone antes, el orquestador es el que las reordena o
pide confirmación.** Eso no lo decide el modelo: lo decide tu código. Esta es
la línea que separa un agente que se puede poner en producción de una demo.

**(b) Qué guardás y con qué granularidad.**

**Granularidad: un registro por paso, escrito ANTES de ejecutar la
herramienta y actualizado DESPUÉS.** Ese "antes" es lo que te salva del
timeout ambiguo.

```sql
CREATE TABLE agente_paso (
  ejecucion_id  uuid NOT NULL,
  n             int  NOT NULL,              -- orden del paso
  herramienta   text NOT NULL,
  argumentos    jsonb NOT NULL,
  arg_hash      text NOT NULL,              -- para deduplicar (módulo 06)
  idem_key      text NOT NULL,              -- la clave que viaja a la herramienta
  estado        text NOT NULL,              -- INICIADO | OK | FALLO | COMPENSADO
  resultado     jsonb,
  PRIMARY KEY (ejecucion_id, n)
);
```

Lo que guardás, y el porqué de cada cosa:

1. **El plan y el estado de cada paso**, con `INICIADO` escrito y commiteado
   **antes** de llamar la herramienta. Si el proceso muere durante el cobro,
   al reanudar encontrás un paso en `INICIADO` y **sabés que no sabés** si
   corrió. Sin ese registro, no tenés ni la pregunta.
2. **Los argumentos exactos y su hash.** El `idem_key =
   hash(ejecucion_id, n, arg_hash)` es lo que hace que reintentar el cobro sea
   seguro: la herramienta ve la misma clave y no cobra dos veces. Módulo 06
   entero, aplicado acá.
3. **El resultado de cada herramienta, literal.** Doble función: no volver a
   pagar los 40 segundos al reanudar, y —más importante— **poder reconstruir
   el contexto del LLM exactamente** como estaba.
4. **El mensaje de usuario y los mensajes del modelo.** Al reanudar hay que
   reconstruir la conversación completa.
5. **El modelo y su versión.** Porque en 3 meses ese modelo puede no existir,
   y te va a hacer falta para entender qué pasó.

Lo que **no** guardás: el objeto de contexto completo serializado en cada
paso. Crece cuadrático y es irreconstruible cuando cambie tu formato. Guardás
los **hechos** (mensajes, llamadas, resultados) y reconstruís el contexto
desde ellos. Es la misma idea que un event store.

Y el detalle operativo que importa: **el usuario cerrando el navegador no es
un fallo.** La ejecución del agente no puede vivir en el request HTTP. Es un
job con su propio ciclo de vida, y el navegador sólo **mira** (SSE,
WebSocket, o polling). Si cerrar la pestaña cancela el trabajo, el diseño
está mal: en el paso 4 ya cobraste.

**(c) Si el LLM devuelve una decisión distinta al reanudar. (la difícil)**

Primero, el hecho: **va a pasar.** `temperature > 0` lo garantiza, y aun con
`temperature = 0` no hay determinismo garantizado (batching, versiones del
modelo, hardware). Si tu diseño necesita que el LLM repita la decisión, tu
diseño está roto.

Entonces: **los pasos ya ejecutados no se vuelven a decidir.** Y la regla que
ordena todo:

> **Las decisiones del LLM son eventos, no funciones puras.**

Lo que ya decidió **se leyó de la base, no se vuelve a preguntar**. El modelo
sólo decide el paso **siguiente**, con el contexto reconstruido de los pasos
que ya corrieron.

```
reanudar(ejecucion_id):
  pasos = SELECT * FROM agente_paso WHERE ejecucion_id = $1 ORDER BY n

  1) ¿hay un paso en INICIADO?  <- el timeout ambiguo, módulo 06
     -> NO se vuelve a decidir, y NO se asume que falló.
        Se reintenta la MISMA llamada con la MISMA idem_key.
        La herramienta resuelve: si ya corrió, devuelve el resultado
        anterior; si no, lo ejecuta. Si la herramienta no es idempotente
        y mueve dinero, va a revisión humana. Punto.

  2) contexto = reconstruir(mensajes + pasos OK con sus resultados)

  3) el LLM decide SÓLO el paso siguiente, con ese contexto.
     Si decide algo distinto de lo que habría decidido antes: está bien.
     Es información nueva (ya sabe los resultados de los pasos 1-4).

  4) si decide un paso que CONTRADICE un efecto ya aplicado
     (p. ej. volver a cobrar algo ya cobrado):
     -> lo frena el código, no el prompt. El guard mira agente_paso.
```

Los tres puntos que hacen la respuesta buena:

1. **El plan completo del LLM no es un contrato, es una sugerencia.** Guardás
   lo que **ejecutó**, no lo que **planeó**. Si guardás el plan y lo tratás
   como contrato, cualquier reanudación es un conflicto.
2. **Las barandas van en código, nunca en el prompt.** "No cobres dos veces"
   en el system prompt es una esperanza. Un `UNIQUE (ejecucion_id, herramienta,
   arg_hash)` sobre los pasos de cobro, más la clave de idempotencia que viaja
   a la herramienta, es una garantía. **Un prompt no es un constraint.**
3. **Hay un límite de reanudaciones.** Si una ejecución se reanudó 5 veces,
   algo está mal estructuralmente: va a revisión humana, no a un sexto
   intento. Es el **retry budget** del módulo 08, aplicado al agente — sin él,
   un agente que falla en el paso 4 es un bucle infinito que consume tokens y
   puede mover dinero en cada vuelta.

Esto está implementado, con código, en **`casos/10-agente-ia-bucle-reanudable.md`**.

### D4 — Proyección en DynamoDB vía Debezium

**(a) El camino, con los puntos de pérdida y duplicación.**

```
[1] Postgres: UPDATE pedido
     |
     |  ⚠️ el WAL es la fuente de verdad. Si el slot de replicación se
     |     pierde o se recrea, el gap NO se recupera: hay que hacer
     |     snapshot de nuevo. PÉRDIDA.
     v
[2] WAL -> slot de replicación lógica
     |
     |  ⚠️ Debezium commitea su offset (LSN) periódicamente. Si muere
     |     después de publicar y antes de commitear, al volver reenvía
     |     desde el último LSN. DUPLICACIÓN. (Es by design: at-least-once.)
     v
[3] Debezium (Kafka Connect)
     |
     |  ⚠️ si el conector corre con acks=1 y el líder de la partición se
     |     cae antes de replicar, se pierde el mensaje. PÉRDIDA.
     |     -> acks=all + min.insync.replicas=2 (módulo 07)
     v
[4] Kafka
     |
     |  ⚠️ retention. Si el consumidor está caído más que el retention,
     |     los mensajes se borran y el lag se vuelve irrecuperable.
     |     PÉRDIDA SILENCIOSA, la peor de todas.
     |     -> alertar por LAG, no por "consumidor vivo"
     v
[5] el consumidor de la proyección
     |
     |  ⚠️ si commitea el offset ANTES de escribir en DynamoDB: PÉRDIDA.
     |     si commitea DESPUÉS (lo correcto): DUPLICACIÓN al reiniciar.
     |     No hay tercera opción (módulo 06): elegís duplicación y la
     |     resolvés con idempotencia.
     |
     |  ⚠️ rebalance a mitad de un lote: los mensajes procesados y no
     |     commiteados se reprocesan. DUPLICACIÓN. (módulo 07)
     v
[6] DynamoDB
     |
     |  ⚠️ si reintentás una escritura condicional y no es idempotente,
     |     aplicás dos veces. Y si procesás DESORDENADO entre particiones,
     |     escribís un valor VIEJO sobre uno NUEVO. Eso no es duplicación:
     |     es CORRUPCIÓN, y no se arregla reintentando.
     v
   la lectura
```

El resumen: **el camino es at-least-once de punta a punta, con ordenamiento
garantizado sólo por partición.** Esas son las dos propiedades con las que
hay que diseñar, y las dos tienen consecuencia directa en (b).

**(b) Por qué la proyección tiene que ser idempotente, y cómo.**

Por (a): la duplicación no es un fallo, es **el modo normal de operación**.
Y hay un segundo motivo más fuerte: **vas a querer reconstruir la proyección**
(B3c), lo que significa reprocesar todo el historial sobre una tabla que ya
tiene datos. Si la proyección no es idempotente, no se puede reconstruir — y
una proyección que no se puede reconstruir es una base de datos primaria
disfrazada.

El cómo, en orden de preferencia:

**1. Escritura condicional por versión (la correcta, y resuelve el orden).**

```ts
// resuelve duplicación Y desorden de una sola vez
await ddb.updateItem({
  Key: { pk: `PEDIDO#${id}` },
  UpdateExpression: 'SET estado = :e, lsn = :lsn, actualizado = :t',
  // sólo escribo si mi evento es MÁS NUEVO que lo que hay guardado
  ConditionExpression: 'attribute_not_exists(lsn) OR lsn < :lsn',
  ExpressionAttributeValues: { ':e': estado, ':lsn': evento.lsn, ':t': now },
});
// ConditionalCheckFailedException = llegó un evento viejo -> descartar, no es error
```

El `lsn` de Postgres (o el offset de Kafka, o un `version` de la fila) es
monótono, así que `lsn <` ordena correctamente. **Un duplicado no pasa la
condición y un evento viejo tampoco.** Y lo mejor: no necesita tabla de dedup.

**2. Operaciones naturalmente idempotentes.** Si la proyección es un
reemplazo completo del item (`PutItem` con el estado entero del pedido),
aplicarla N veces da el mismo resultado. **Esto es por qué las proyecciones
se diseñan como "el estado completo", no como "el delta".** Un
`ADD cantidad :1` no es idempotente y es un bug esperando.

**3. Tabla de dedup por `eventId`** (el inbox del módulo 02). Funciona, pero
cuesta una escritura extra por evento y no resuelve el desorden. Es el plan
B cuando no podés hacer la condicional.

Y la pieza que falta en el 90% de las implementaciones: **la clave de
partición de Kafka tiene que ser el `pedidoId`** (módulo 07). Si no, dos
eventos del mismo pedido caen en particiones distintas, se procesan en
paralelo, y el orden entre ellos **no existe**. Ninguna cantidad de
idempotencia arregla eso: la escritura condicional del punto 1 te salva de
corromper, pero vas a descartar eventos y perder actualizaciones. La clave
correcta es la primera línea de defensa, y es gratis.

**(c) El slot de replicación que se queda atrás.**

Este es **el** riesgo operativo de CDC, y está en `outbox-brokers.md`:

```
Debezium se cae (o Kafka se cae, o el conector se traba)
   -> el slot de replicación NO avanza
   -> Postgres NO PUEDE reciclar el WAL: tiene que guardarlo para el slot
   -> pg_wal crece sin parar
   -> ⚠️ Y además: VACUUM no puede limpiar tuplas muertas que el slot
      todavía podría necesitar -> bloat de tablas e índices
   -> el disco de tu base PRIMARIA se llena
   -> Postgres deja de aceptar escrituras
   -> tu aplicación entera está caída
```

**Un consumidor caído tira abajo tu base de datos primaria.** Es el acoplamiento
más peligroso de toda esta arquitectura, y es exactamente lo contrario de lo
que uno espera: elegiste CDC para desacoplar, y te quedó la base primaria
atada a la salud de un conector de Kafka.

Lo que hay que tener **antes** de poner Debezium en producción:

1. **Alerta sobre el lag del slot, no sobre el disco.** El disco es el síntoma
   final y llega tarde:

   ```sql
   SELECT slot_name, active,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS atraso
   FROM pg_replication_slots;
   ```

   Alerta a 1 GB (warning) y 5 GB (crítico), con el `active = false` como
   alerta propia e inmediata.

2. **`max_slot_wal_keep_size`** (Postgres ≥ 13). **Es la línea más importante
   de toda esta respuesta.** Pone un techo: pasado ese tamaño, Postgres
   **invalida el slot** en vez de llenar el disco.

   Eso convierte "mi base de datos primaria está caída" en "tengo que
   re-snapshotear la proyección". Es sacrificar la proyección para salvar la
   base, y es **siempre** el trade-off correcto: la proyección es derivada y
   reconstruible (B3c); la base primaria, no.

3. **Un runbook para el re-snapshot**, probado. Si el slot se invalida, hay
   que rehacer el snapshot inicial de Debezium, que en una tabla grande es
   horas y carga sobre la base. Saber cuánto tarda **antes** del incidente es
   la diferencia entre un procedimiento y una improvisación.

4. **Monitoreo del bloat** de las tablas calientes, que es el daño silencioso:
   el disco puede estar bien y el rendimiento ya estar degradado.

**Y la pregunta de diseño que esto obliga a hacerse:** si todo esto te asusta
—y debería—, **la outbox explícita no tiene este problema.** Un worker leyendo
`SELECT ... FROM outbox WHERE publicado = false` que se cae sólo hace crecer
una tabla, y una tabla grande no te tira la base. El precio es que tus
escrituras tienen que acordarse de insertar en la outbox; CDC te da eso
"gratis" leyendo el WAL.

**Ese es el trade-off real entre outbox y CDC**, y no es "cuál es más
elegante": es **dónde querés el riesgo operativo.** Está desarrollado en
`outbox-brokers.md` y en `outbox-cuando.md`.

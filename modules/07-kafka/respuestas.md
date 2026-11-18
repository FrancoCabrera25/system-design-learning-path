# Respuestas modelo — Módulo 07

> Abrilo **después** de escribir las tuyas en `mis-respuestas/07.md`.

---

## Bloque A — Conceptos

### A1 — ¿Kafka o SQS?

**Las dos razones reales para elegir Kafka:**

1. **Retención y reproceso.** El mensaje no se borra al consumirlo: podés
   mover el offset para atrás y volver a leer tres meses de histórico para
   reconstruir una proyección, arreglar un bug de un consumidor, o alimentar
   un servicio nuevo que necesita todo el pasado. **En una cola el mensaje se
   borró y no hay nada que hacer.**
2. **Varios consumidores independientes del mismo stream.** Facturación,
   analytics, notificaciones y búsqueda leen `order.created` cada uno con su
   propio offset, sin saber de los demás y sin coordinarse. Con SQS necesitás
   SNS por delante y una cola por consumidor, y cada uno recibe **su copia**.

Una tercera, legítima pero más matizada: **orden garantizado por clave a alto
volumen**. SQS FIFO también ordena por *message group*, pero con límites de
throughput mucho más bajos.

**Por qué el throughput NO es una razón:** SQS absorbe ráfagas enormes sin
tunear nada, y escala solo. El 95% de los sistemas que "necesitan Kafka por
volumen" manejan cientos o miles de mensajes por segundo — territorio donde
SQS no se entera. Si tu argumento es "escala mejor" y tenés 200 eventos/s, no
tenés un argumento.

Y el costo que hay que nombrar: **MSK te evita operar brokers, no te evita la
complejidad conceptual** — particiones que no se pueden reducir, rebalances,
offsets, lag, poison pills. **Esa es la parte cara.** Si el equipo no va a
aprender eso, SQS es una decisión más honesta que un Kafka mal operado.

### A2 — Cola vs log

- **Cola**: el consumidor **saca** el mensaje; al hacer ack, **se borra**. El
  broker lleva la cuenta, mensaje por mensaje.
- **Log**: el mensaje **se queda**; el consumidor avanza un **puntero**
  (offset). La cuenta la lleva el consumidor.

**Tres consecuencias prácticas:**

1. **Podés reprocesar.** Mover el offset para atrás es una operación normal, no
   un rescate heroico. Es la razón #1 para elegir Kafka.
2. **Varios grupos leen lo mismo sin interferirse**, porque cada uno tiene sus
   propios offsets. Un consumidor lento no afecta a los otros.
3. **No hay ack por mensaje**, y de ahí salen los dos dolores de Kafka: un
   mensaje envenenado **bloquea su partición** (C2), y reintentar uno solo es
   incómodo (hay que construir *retry topics*, porque no hay DLQ nativa).

Una cuarta que suma: **el almacenamiento se dimensiona por retención, no por
backlog**. En una cola, un consumidor caído hace crecer la cola; en Kafka los
datos ya estaban ahí y lo único que crece es el lag.

### A3 — Cómo garantizar el orden

> **Poniendo la misma `key` en los mensajes que tienen que estar ordenados.**
> `partición = murmur2(key) % numPartitions`, y dentro de una partición el
> orden es estricto y garantizado.

**Qué perdés a cambio:**

1. **Paralelismo.** Los mensajes de esa clave los procesa **un solo
   consumidor**, secuencialmente.
2. **Riesgo de partición caliente.** Si la clave es gruesa (`tenantId`), una
   partición concentra el tráfico y su consumidor es el cuello de botella de
   todo el grupo (B2).
3. **Flexibilidad futura**: aumentar particiones cambia el mapeo y rompe el
   orden entre lo viejo y lo nuevo (B4).

**Por qué "orden global" es incorrecto:** el orden en Kafka es **por
partición**, no por topic. Orden global significa **una sola partición**, o
sea **cero paralelismo**: un consumidor para todo el topic. Es técnicamente
posible y casi siempre inaceptable.

La respuesta correcta en una entrevista no es "sí, Kafka ordena": es
**"¿orden de qué?"**. Casi nunca se necesita orden entre entidades distintas
— sólo dentro de cada una.

### A4 — Consumer groups

Un conjunto de consumidores que **se reparten** las particiones de un topic y
comparten un conjunto de offsets. La regla:
**cada partición la consume exactamente un consumidor del grupo.**

- **20 consumidores, 6 particiones** → 6 trabajan, **14 quedan idle**: vivos,
  pasando health checks, consumiendo CPU y memoria, **sin recibir un solo
  mensaje**. El throughput es idéntico al de 6 consumidores.
- **6 consumidores, 20 particiones** → cada uno toma 3-4 particiones.
  **Perfectamente normal y además deseable**: te deja escalar hasta 20
  consumidores más adelante sin tocar la topología del topic.

De ahí la regla de diseño: **sobredimensioná las particiones, no los
consumidores.** Las particiones son el techo; los consumidores se agregan y se
quitan en un `kubectl scale`.

### A5 — `session.timeout.ms` vs `max.poll.interval.ms`

| | Qué vigila | Quién lo mantiene |
| --- | --- | --- |
| `session.timeout.ms` (45 s) | Que el **proceso esté vivo** | Un **hilo de heartbeats**, aparte |
| `max.poll.interval.ms` (5 min) | Que el consumidor **esté progresando** | El **hilo principal**, llamando a `poll()` |

**Por qué podés enviar heartbeats y aun así ser expulsado:** porque los
heartbeats van en un hilo **separado** del que procesa. Si tu handler tarda 7
minutos con un batch, los heartbeats siguen saliendo puntualmente —el proceso
está vivo— pero **no volvés a llamar a `poll()`**, y a los 5 minutos el
coordinador decide que no estás progresando y te saca del grupo.

Es una distinción deliberada: Kafka separa *"¿estás vivo?"* de *"¿estás
avanzando?"*, porque un consumidor vivo y trabado es igual de inútil que uno
muerto — y es peor, porque retiene sus particiones.

**`max.poll.interval.ms` es el que muerde**, y es la causa del loop de
rebalances (C3).

### A6 — Log compaction

`cleanup.policy=compact` hace que Kafka conserve **el último valor de cada
clave, para siempre**, en vez de borrar por tiempo.

```
Antes:   (u1,"Ana") (u2,"Beto") (u1,"Ana M.") (u2,null) (u3,"Caro")
Después: (u1,"Ana M.")          (u3,"Caro")
```

Un **tombstone** es un mensaje con `value = null`: marca la clave como
borrada, y después de un período de gracia la compactación la elimina del log.
Es lo que hace posible borrar de verdad en un log append-only — y, de paso, es
el mecanismo con el que se implementa un borrado por GDPR en un stream.

**Correcto:** un topic que representa **estado** — *"el valor actual de X es
Y"*. Perfiles de usuario, configuración, feature flags, el CDC de una tabla,
las *KTable* de Kafka Streams. El topic se vuelve una tabla que cualquier
consumidor nuevo puede leer desde el principio para reconstruir el estado
completo.

**Error:** un topic de **eventos** — *"pasó esto"*. Un log de auditoría, los
pagos, los clicks. La compactación **destruye el histórico**: si tenés tres
cambios de estado de una orden y sólo sobrevive el último, perdiste
exactamente la información por la que tenías un log de eventos. Y es
irreversible.

La regla: **compactá el estado, retené los eventos.**

### A7 — `enable.idempotence=true`

El broker le asigna al productor un **PID** y una **secuencia por partición**,
y descarta los mensajes cuya secuencia ya vio. Eso resuelve un problema
concreto: si el productor manda un mensaje, el ack se pierde y **el productor
reintenta**, el broker reconoce el duplicado y no lo escribe dos veces. Además
preserva el orden con hasta 5 requests en vuelo (sin idempotencia, un
reintento puede reordenar).

Es el default desde Kafka 3.0, y fuerza `acks=all`.

**¿Te da idempotencia de negocio? NO.** Y la distinción es exactamente la del
módulo 06:

- Deduplica **los reintentos del mismo productor, en la misma sesión, por
  secuencia**.
- **No** deduplica dos publicaciones **lógicamente iguales** originadas en dos
  requests distintas, ni en dos pods distintos, ni después de que el productor
  se reinicie (al reiniciar obtiene un PID nuevo y la secuencia arranca de
  cero).

O sea: si tu `POST /orders` se reintenta y tu servicio publica
`order.created` dos veces, **son dos mensajes distintos para Kafka** y el
productor idempotente no los va a tocar. La idempotencia de negocio es la del
módulo 06: clave + `UNIQUE` + handler idempotente.

(Con `transactional.id` estable sí ganás algo más: el *fencing* de productores
zombi entre reinicios. Sigue siendo idempotencia de transporte, no de negocio.)

> **Rúbrica bloque A**
> - **Mid:** sabe que Kafka particiona y que la key da orden.
> - **Senior:** nombra retención/reproceso y múltiples grupos como las razones
>   reales, distingue los dos timeouts, y sabe para qué sirve la compactación.
> - **Staff:** dice que "orden global" es una no-respuesta, y separa la
>   idempotencia del productor de la idempotencia de negocio.

---

## Bloque B — Particiones y claves

### B1 — 3 a 12 réplicas y el lag no baja

**(a) La primera pregunta: "¿cuántas particiones tiene el topic?"**

Y la segunda, casi tan importante: *"¿el lag crece en todas las particiones o
en una sola?"*. Si crece en una sola, no es un problema de escala: es una
partición caliente (B2), y agregar consumidores no cambia nada.

**(b) La cuenta:**

```
throughput por consumidor = 1000 ms / 80 ms   = 12,5 msg/s
particiones necesarias    = 1.200 / 12,5      = 96 PARTICIONES
```

Con 6 particiones, el techo del **grupo entero** es `6 × 12,5 = 75 msg/s`
contra 1.200 que entran. El lag no crece despacio: crece **1.125 mensajes por
segundo**, para siempre, con 3 pods o con 50.

**(c) Por qué el HPA empeora la situación:** los pods idle **no consumen CPU**.
Al agregarlos, el **promedio** de CPU del deployment **baja** — así que el HPA
escala más. Cada pod nuevo baja más el promedio y justifica el siguiente.
Terminás con 50 pods, el throughput de 6, y un HPA convencido de estar
haciendo su trabajo.

Es el mismo patrón que el gRPC con balanceo L4 del módulo 02: **la métrica
dice que escalaste, la realidad dice que no.**

**(d) Las tres palancas:**

| Palanca | Efecto | El costo |
| --- | --- | --- |
| **Subir a 96 particiones** | Resuelve de raíz | No se pueden reducir después; cambia `key→partición` y rompe el orden entre lo viejo y lo nuevo (B4) |
| **Concurrencia dentro del consumidor** | Multiplica sin tocar el topic | **Perdés el orden dentro de la partición** y el manejo de offsets se complica: no podés commitear N hasta que todo ≤ N terminó |
| **Bajar los 80 ms** | 80→20 ms cuadruplica el throughput | Ninguno. **Es la más barata y la que nadie prueba primero** |

Para la tercera: batchear las escrituras a la base, sacar una llamada HTTP
sincrónica del handler, cachear algo. Suele haber un 4x disponible sin tocar
ninguna garantía.

### B2 — `key = tenantId` y un tenant que es el 50%

**(a)** La partición de ese tenant recibe el 50% del tráfico: **600 msg/s
contra una capacidad de 12,5**. Su lag crece sin límite mientras **las otras
11 particiones están casi ociosas**. El grupo tiene capacidad de sobra y no
puede usarla, porque el trabajo no se puede mover de partición.

**(b) ¿Lo arregla pasar a 96 particiones? NO.** `murmur2("tenant-x") % 96`
sigue dando **un** número. El mega-tenant sigue entrando por una sola puerta.

La simulación lo muestra: de 12 a 200 particiones, la capacidad total del
grupo se multiplica por 17 y **la partición caliente sigue recibiendo el 40%**.

> **Agregar particiones nunca arregla una partición caliente. Lo único que la
> arregla es cambiar la clave.**

**(c) Por qué el lag total se ve sano:** el total es la **suma** de 96
particiones, y los dashboards suelen mostrar el promedio o el total del grupo.
Una partición con lag creciente entre 95 vacías se diluye. Sumale que la CPU
está baja y hay capacidad de sobra, y tenés todos los indicadores en verde
mientras un tenant está roto. **La única métrica que lo muestra es el lag por
partición** — y es la que casi nadie grafica.

**(d) Dos opciones:**

1. **Cambiar la clave a la entidad más fina cuyo orden importe** — casi
   siempre `orderId` en vez de `tenantId`. ¿De verdad necesitás orden entre
   dos órdenes distintas del mismo tenant? Casi nunca. La clave gruesa te da
   un orden que no usás y una partición caliente que sí sufrís. En la
   simulación esto lleva la partición más cargada del 42,9% al 8,5%.
2. **Si de verdad necesitás orden por tenant:** clave compuesta con
   sub-partición, `tenantId:bucket` con N buckets por tenant (el bucket se
   elige con un hash **estable** de la entidad, nunca al azar). Te da orden
   dentro del bucket y reparte la carga. O un **topic dedicado** para el
   mega-tenant, con sus propias particiones y consumidores: feo, aislado, y
   funciona.

### B3 — Qué clave para cada caso

| Caso | Clave | Orden que da |
| --- | --- | --- |
| **(a)** Eventos de una orden | **`orderId`** | Por orden: `created` → `paid` → `shipped` nunca se desordenan. Es el caso de manual |
| **(b)** Clicks de analytics, 50k/s | **`null`** | Ninguno, y no hace falta. Reparto perfecto y máximo throughput |
| **(c)** Cambios de saldo | **`accountId`** | Por cuenta. Acá el orden **sí** es obligatorio: aplicar un débito y un crédito al revés puede dejar el saldo negativo transitoriamente o romper una validación |
| **(d)** Mensajes de chat | **`conversationId`** | Por conversación. Que los mensajes de dos chats distintos se mezclen no importa; dentro de uno, sí |
| **(e)** Eventos de un agente de IA | **`conversationId`** | Orden por conversación y paralelismo entre conversaciones. Es exactamente la granularidad correcta |

El patrón: **la clave es la entidad que el usuario percibe como "una cosa"**.
Y (c) es el único donde el orden es una restricción de corrección y no una
comodidad — por eso ahí se acepta el riesgo de partición caliente si una
cuenta es muy activa.

### B4 — Aumentar sí, reducir no

**Por qué no se pueden reducir:** cada partición es un log con sus propios
offsets y sus propios datos. Eliminar una obligaría a decidir qué hacer con
sus mensajes (¿se borran? ¿se mueven, rompiendo los offsets?), invalidaría los
offsets commiteados de todos los grupos, y rompería el mapeo de claves. Kafka
simplemente no lo ofrece.

**Qué se rompe al aumentarlas:** el divisor de `murmur2(key) % N` cambia.
Entonces, para una clave dada, **los mensajes nuevos van a una partición
distinta de la que tiene su historial**. Concretamente:

- El orden **entre lo viejo y lo nuevo** de esa clave ya no está garantizado:
  un consumidor puede leer el evento nuevo en la partición 47 **antes** que
  uno viejo que todavía está pendiente en la partición 3.
- Si tu consumidor mantiene estado por clave (una proyección, una máquina de
  estados), **ese estado estaba en el consumidor de la partición vieja**.

**Cómo planificarlo**, de mejor a peor:

1. **Topic nuevo con la cantidad correcta** y migración de productores y
   consumidores (expand/migrate/contract del módulo 02). Es la opción limpia:
   el mapeo viejo queda intacto y vos controlás el corte.
2. **Drenar el topic antes de aumentar**: parar los productores, esperar lag
   cero, aumentar, retomar. Requiere una ventana, y es seguro.
3. **Aumentar en caliente y tolerar el desorden transitorio**, si el
   consumidor es idempotente y no depende del orden. Hay que decidirlo
   explícitamente, no descubrirlo después.

### B5 — Dimensionar un topic nuevo

```
throughput por consumidor = 1000 / 15 ms  = 66,7 msg/s
mínimo                    = 300 / 66,7    = 4,5  -> 5 particiones
```

**Elijo 12.** El razonamiento, que es lo que se evalúa:

- **Margen de 2-3x sobre el pico proyectado**, porque las particiones son
  baratas hoy y carísimas de cambiar después (B4). Con 12 aguanto `12 × 66,7 =
  800 msg/s`, casi 3x el tráfico actual.
- **12 tiene muchos divisores** (1, 2, 3, 4, 6, 12), así que el reparto entre
  consumidores queda parejo con casi cualquier cantidad de pods. Con 11
  particiones y 6 consumidores, cinco toman 2 y uno toma 1: desbalance
  permanente. Es un detalle chico y gratis.
- No elijo 96 "por las dudas": cada partición cuesta archivos abiertos,
  memoria en el broker, metadata y tiempo de rebalance. 12 es el punto dulce
  para este volumen.

Y lo que digo en voz alta: *"si el tráfico se multiplica por 10, el plan es
topic nuevo y migración, no aumentar en caliente"*.

> **Rúbrica bloque B**
> - **Mid:** hace la cuenta de particiones y sabe que la key da orden.
> - **Senior:** ve la trampa del HPA, sabe que agregar particiones no arregla
>   una partición caliente, y elige la clave por granularidad de negocio.
> - **Staff:** propone la clave compuesta con buckets, planifica el cambio de
>   particiones como migración de topic, y elige un número con muchos divisores.

---

## Bloque C — Operación

### C1 — Diagnosticar lag creciente

El orden importa, porque cada paso descarta una familia entera de causas:

**1. ¿El lag crece en TODAS las particiones o en UNA?**
→ Si es una: **partición caliente** (B2). Fin del diagnóstico, no es escala.
→ Si es en todas: seguí.

**2. ¿Cuántas particiones y cuántos consumidores activos hay?**
→ Si `consumidores > particiones`, hay pods idle y escalar no sirve (B1).
→ Mirá la asignación real, no el número de pods.

**3. ¿El grupo está rebalanceando?**
→ Si rebalancea seguido, el problema no es capacidad: es el loop de C3. El
  progreso puede ser **cero** aunque todo parezca activo.

**4. ¿Cambió el tiempo de procesamiento por mensaje?**
→ Compará el p99 del handler contra la semana pasada. Si subió, el problema
  está **aguas abajo** (la base, una API externa, el pool de conexiones) y es
  el módulo 01 otra vez. Escalar consumidores sólo le va a pegar más fuerte a
  lo que ya está lento.

**5. ¿Cambió la tasa de producción?**
→ Si λ se duplicó, no hay nada roto: hay que escalar. Es la causa más
  aburrida y conviene descartarla temprano para no buscar bugs que no existen.

**6. ¿Hay una partición trabada en el mismo offset?**
→ **Poison pill** (C2). El síntoma: el offset commiteado de esa partición no
  avanza y los logs repiten la misma excepción.

**7. Recursos del consumidor**: event loop lag, GC, memoria (módulo 01, C1).

Lo que **no** hay que hacer primero: escalar réplicas. Es la reacción refleja
y en 4 de estos 7 casos no cambia nada — y en el caso 4 lo empeora.

### C2 — El mensaje con JSON corrupto

**(a) Su partición se traba.** El handler lanza, el offset **no se commitea**,
el consumidor vuelve a hacer `poll()` desde el mismo offset, y procesa **el
mismo mensaje** otra vez. Para siempre.

**(b) Los mensajes detrás nunca se procesan.** El lag de esa partición crece
sin límite — y como es una sola partición entre N, el lag **total** del grupo
puede verse casi normal (B2c).

**(c) ¿Por qué no alcanza con `try/catch` + log + seguir?** Porque eso
**pierde el mensaje en silencio**. Commiteás el offset, el mensaje queda
descartado, y la única huella es una línea de log entre millones. Cambiaste
una partición trabada —ruidosa, visible, que alguien va a investigar— por
**pérdida de datos invisible**, que es estrictamente peor.

Y encima no distingue un JSON corrupto (que nunca va a funcionar) de un
timeout de la base (que funcionaría en 10 segundos). Con `catch` y seguir,
**descartás los dos por igual**.

**(d) La solución completa:**

```
1. REINTENTO LOCAL ACOTADO
   3 intentos con backoff + jitter (módulo 08). Resuelve los
   transitorios, que son la mayoría.

2. CLASIFICAR EL ERROR
   - Permanente (JSON inválido, schema incompatible, FK que no existe):
     no reintentar más. Va al paso 3.
   - Transitorio (timeout, 503, deadlock de Postgres): vale la pena
     reintentar más tarde. Va al RETRY TOPIC.

3. RETRY TOPICS CON DELAY ESCALONADO
   orders.retry.5s -> orders.retry.1m -> orders.retry.10m
   Cada uno con su consumidor que espera el delay antes de procesar.
   Y en cada salto se commitea el offset del topic original, así la
   partición SE DESBLOQUEA.

4. DLQ DESPUÉS DE N INTENTOS
   orders.DLQ con el mensaje original + headers con: el error, el
   stack, el topic/partición/offset de origen, el número de intentos
   y el timestamp. Sin esos headers, la DLQ es un cementerio inútil.

5. ALERTA SOBRE LA PROFUNDIDAD DE LA DLQ
   Un mensaje en la DLQ es un incidente, no una estadística.

6. HERRAMIENTA DE REPROCESO
   Un comando que relea la DLQ y reinyecte al topic original después
   de arreglar el bug. Si no existe, nadie va a vaciar la DLQ nunca.
```

**El costo que hay que nombrar:** mandar un mensaje a un retry topic **rompe
el orden de su clave**. Si el orden es crítico (saldos de una cuenta,
máquina de estados de un pago), la decisión correcta puede ser la contraria:
**detener la partición y despertar a un humano**, porque procesar el mensaje
siguiente sin el anterior corrompe el estado. Es una decisión de negocio, no
técnica, y conviene decirlo así.

### C3 — Rebalance cada 5 minutos, lag en línea recta

**(a) Es el loop de rebalances**, y la pista está en el número: 5 minutos es
exactamente `max.poll.interval.ms`. El batch tarda más que ese intervalo, así
que el coordinador declara muerto al consumidor **aunque los heartbeats
sigan saliendo** (A5).

```
1. poll() trae 10.000 registros
2. el handler tarda 13 min (10.000 × 80 ms)
3. a los 5 min: expulsado del grupo -> rebalance
4. otro consumidor toma la partición DESDE EL ÚLTIMO OFFSET COMMITEADO
5. trae los mismos 10.000, tarda lo mismo, lo expulsan igual
6. volver a 3
```

**El progreso real es cero.** La simulación lo muestra: con
`max.poll.records = 10.000` y 80 ms por mensaje, el batch tarda 800 segundos
contra un intervalo de 300.

**(b) Por qué no sale solo:** porque **el reproceso alimenta la causa**. Cada
vuelta vuelve a empezar desde el mismo offset, así que el trabajo pendiente no
baja nunca y el tiempo de batch no cambia. Es un **fallo metaestable**
(módulo 01): el sistema se queda en el estado malo aunque la carga original
baje, porque ahora la carga **es** el reproceso.

**(c) Cinco formas, ordenadas:**

1. **Bajar `max.poll.records`.** El arreglo inmediato y el más seguro. Regla
   práctica: que el **peor** batch tarde menos del 25% de
   `max.poll.interval.ms`.
2. **Commits manuales más frecuentes** (cada N mensajes, no por batch). Así,
   aunque te expulsen, el reproceso es chico en vez de ser el batch entero.
3. **Hacer el handler más rápido.** Ataca la causa: batchear escrituras, sacar
   llamadas sincrónicas.
4. **Subir `max.poll.interval.ms`.** Funciona y hay que usarlo con cuidado: si
   el consumidor de verdad se cuelga, el grupo tarda todo ese tiempo en
   notarlo.
5. **Cooperative sticky + static membership**, para que los rebalances que sí
   ocurren cuesten mucho menos (C4).

**(d) La métrica que avisa antes que el lag: la tasa de rebalances del grupo**
(o los incrementos del *generation id*). Un grupo que rebalancea cada 5
minutos está roto **aunque el lag todavía sea chico** — y cuando el lag se
note, ya perdiste media hora. Un complemento útil: **tiempo desde el último
commit exitoso** por partición.

### C4 — Rolling deploy de 24 pods

**Cuántos rebalances:** con el protocolo **eager**, al menos **uno por pod**
que entra o sale del grupo — en la práctica hasta dos (uno cuando el viejo se
va, otro cuando el nuevo se une), así que **24 a 48 rebalances por deploy**. Y
en cada uno, **el grupo entero deja de consumir**: todos devuelven todas sus
particiones y se reparte de cero.

**Cuántos mensajes:** con 4 segundos por rebalance y 1.200 msg/s:

```
24 rebalances × 4 s × 1.200 msg/s = 115.200 mensajes no consumidos por deploy
```

Con 5 deploys por día, la simulación da **609.600 mensajes/día** de parada. El
lag sube en escalera cada vez que alguien aprieta "deploy".

**Los dos cambios de configuración:**

1. **`CooperativeStickyAssignor`.** Deja de ser stop-the-world: sólo se mueven
   las particiones que hace falta mover, y los consumidores que no pierden
   ninguna **siguen trabajando**. Baja el costo por un factor igual al número
   de consumidores.
2. **Static membership (`group.instance.id`).** Le da identidad fija a cada
   consumidor, así que **un reinicio no cuenta como salida del grupo**: si el
   pod vuelve dentro de `session.timeout.ms`, retoma **sus** particiones y no
   hay rebalance. Para un `StatefulSet` que se reinicia en cada deploy,
   elimina la causa principal.

Juntas llevan los 609.600 mensajes/día a **1.400**. Son dos líneas de
configuración, no un rediseño — y es la clase de arreglo que conviene tener
en la punta de la lengua.

### C5 — `acks` y `min.insync.replicas`

| Config | Qué perdés |
| --- | --- |
| `acks=0` | Todo: no esperás nada. **Perdés mensajes sin enterarte** |
| `acks=1` | El leader confirma y **puede morir antes de replicar**: ese mensaje no existe más |
| `acks=all` + `min.insync.replicas=1` | ⚠️ **La trampa**: si las réplicas se atrasan y el ISR queda sólo con el leader, `acks=all` **degenera silenciosamente en `acks=1`**. Creés que estás seguro y no lo estás |
| **`acks=all` + `min.insync.replicas=2`** | Nada de durabilidad. Con RF=3 toleras perder 1 broker y seguís escribiendo |

**Mi elección con RF=3: `acks=all` + `min.insync.replicas=2`** (y
`enable.idempotence=true`, que es el default y fuerza `acks=all`).

Por qué: tolerás la pérdida de **un** broker sin perder datos y sin dejar de
escribir. Si se caen **dos**, los productores empiezan a fallar — y eso es
**una decisión deliberada**: elegís consistencia sobre disponibilidad
(módulo 05, CAP). Para eventos que representan dinero o compromisos con el
cliente, es la decisión correcta: **mejor rechazar la escritura que aceptarla y
perderla**.

Y el detalle de la fila 3 es el que más vale decir en una entrevista: *"`acks=all`
sin `min.insync.replicas` es una falsa sensación de seguridad"*.

> **Rúbrica bloque C**
> - **Mid:** sabe que un mensaje que falla bloquea la partición y propone DLQ.
> - **Senior:** diagnostica el lag en el orden correcto, diseña retry topics
>   con clasificación de errores, y reconoce el loop de rebalances por el "5 minutos".
> - **Staff:** ve que `try/catch` + seguir es pérdida silenciosa, nombra la
>   trampa de `min.insync.replicas=1`, y alerta sobre la tasa de rebalances.

---

## Bloque D — Diseño abierto

### D1 — Reprocesar 3 meses sin afectar a nadie

**El mecanismo es la ventaja central de Kafka sobre una cola: un consumer
group nuevo.**

```
1. Crear un GRUPO NUEVO (group.id = "proyeccion-v2-backfill").
   Tiene SUS PROPIOS offsets: los consumidores actuales no se enteran
   de que existe. Esto es gratis y no toca nada de producción.

2. Posicionarlo: seek por timestamp (kafka-consumer-groups
   --reset-offsets --to-datetime) al inicio de los 3 meses.

3. Escribir en una tabla/índice NUEVO, no en el de producción.
   Expand/migrate/contract (módulos 02 y 05): cuando la proyección
   nueva esté completa y verificada, se cambian las lecturas con un
   feature flag.
```

**El rate limit de la base mientras drenás a máxima velocidad:** es el
problema real de esta pregunta. 3 meses de eventos a máxima velocidad son
**cientos de veces el throughput normal**, y **vas a tumbar la base de
producción con tu propio backfill**. Es la misma lección del módulo 04: *después
de una caída conviene drenar despacio, no rápido.*

Las defensas:

- **Rate limiting explícito en el consumidor de backfill**, calibrado contra
  la capacidad que te sobra, no contra la que tenés.
- **Menos consumidores** en el grupo de backfill que en el de producción:
  tardás más y no competís.
- **Aislar los recursos**: pool de conexiones propio, y si se puede, una
  réplica dedicada. Así el backfill no puede agotar el pool de producción
  (módulo 01, C2).
- **Horario de baja carga**, y la posibilidad de pausarlo (es un grupo
  aparte: pausarlo es escalar a cero).

**Y si el handler manda mails:** acá está el punto de diseño. Reprocesar 3
meses mandaría **3 meses de mails de golpe** — un incidente de reputación, no
un bug.

La respuesta correcta no es "le ponemos un `if`": es que **el diseño tenga
separada la parte pura de la impura**.

```
handler = proyectar(evento)        <- puro: calcula estado. SE PUEDE REPLAY-EAR
        + efectos(evento)          <- impuro: mails, pagos, APIs. NO
```

Con esa separación, el consumidor de backfill ejecuta **sólo la proyección**.
Si además los efectos salen por un outbox con clave de deduplicación
determinística (módulo 06), el replay queda absorbido por la idempotencia
incluso si alguien se olvida del flag.

Y la versión corta para una entrevista: **"un evento se puede reprocesar; un
mail no se puede des-enviar. Por eso la lógica que deriva estado y la que
produce efectos no pueden vivir en la misma función."**

### D2 — Pipeline de eventos para agentes de IA

**Los topics:**

| Topic | Clave | Por qué |
| --- | --- | --- |
| `conversation.message.requested` | `conversationId` | Orden por conversación, paralelismo entre conversaciones |
| `agent.step.completed` | `conversationId` | La traza de cada paso del bucle, para reanudar (módulo 06, D4) |
| `conversation.response.ready` | `conversationId` | Para notificar / actualizar la UI |
| `agent.trace` | `conversationId` | Observabilidad y evals. Retención larga, `cleanup.policy=delete` |
| `*.retry.{5s,1m,10m}` + `*.DLQ` | — | C2 |

**Cuántas particiones — y acá hay una idea que conviene traer:**

```
latencia del LLM:      6 s promedio
cuota del proveedor:   150 llamadas concurrentes
throughput máximo:     150 / 6 s = 25 msg/s
```

Si cada partición procesa **un mensaje a la vez** (que es lo que querés para
tener orden por conversación), entonces:

> **La cantidad de particiones ES tu límite de concurrencia hacia el
> proveedor.** Con 150 particiones y un mensaje en vuelo por partición, nunca
> podés exceder 150 llamadas concurrentes — **la topología del topic te da el
> control de concurrencia gratis.**

Elijo **192 particiones** (margen sobre 150, y muchos divisores). Y agrego un
**semáforo en Redis** como segunda línea, porque el día que alguien active
concurrencia dentro del consumidor, el límite de particiones deja de
proteger.

**Cómo no exceder la cuota**, en capas:

1. Particiones como límite estructural (arriba).
2. Semáforo/limitador de concurrencia global en Redis, dimensionado con la
   cuota real.
3. **Backpressure natural**: si el proveedor se pone lento, los consumidores
   tardan más, **el lag crece — y eso es lo correcto**. El pico se acumula en
   Kafka, donde es visible y medible, en vez de en la memoria de tus pods,
   donde es invisible hasta que se caen (módulo 03).
4. Reintentos con backoff + jitter ante `429`, nunca inmediatos.

**Autoescalado: KEDA por consumer lag**, con el tope en la cantidad de
particiones (pasarse es agregar pods idle, B1). Nunca por CPU: el servicio
espera I/O el 90% del tiempo y la CPU no se mueve (módulo 03).

**Deploy a mitad de una generación de 40 segundos:**

1. El pod recibe `SIGTERM`. Si no lo maneja, la llamada al LLM se corta: **ya
   pagaste los tokens y perdiste el resultado**.
2. El offset no se commiteó → otro consumidor reprocesa el mensaje → **lo
   pagás de nuevo** (módulo 06, D3: USD 219.000/año por este mecanismo).

Lo que hay que tener:

- **Persistir cada paso del bucle** apenas termina, con `UNIQUE (messageId,
  stepIndex)` (módulo 06, D4). Al reprocesar, los pasos completos **se leen,
  no se re-ejecutan**: el bucle es reanudable y no se vuelve a pagar nada.
- **`max.poll.records = 1`** (o 2) en este topic. Con 40 s por mensaje y el
  default de 500, el batch tardaría 5,5 horas y caerías en el loop de
  rebalances de C3. **Es el ajuste no obvio más importante de este diseño.**
- **`max.poll.interval.ms` cómodamente por encima del peor caso** (40 s). Con
  `max.poll.records = 1`, el default de 5 minutos alcanza y sobra.
- **Manejo de `SIGTERM`** + `terminationGracePeriodSeconds > 40` para terminar
  la generación en curso antes de salir.
- **Cooperative sticky + static membership**, para que el deploy no revoque
  todas las particiones (C4).

> **Rúbrica bloque D**
> - **Mid:** usa un grupo nuevo para el backfill y pone `conversationId` como clave.
> - **Senior:** limita el rate del backfill y aísla sus recursos; separa la
>   proyección de los efectos; dimensiona particiones con la cuota del proveedor.
> - **Staff:** usa la cantidad de particiones COMO control de concurrencia, ve
>   que `max.poll.records=1` es obligatorio con tareas de 40 s, y hace el bucle
>   reanudable para no volver a pagar tokens.

---

## Fuentes para profundizar

- **Kafka**, *Design* — la documentación oficial es inusualmente buena:
  <https://kafka.apache.org/documentation/#design>
- **Kafka**, *Consumer configs* (los tres timeouts):
  <https://kafka.apache.org/documentation/#consumerconfigs>
- **KIP-429**, *Incremental Cooperative Rebalancing*:
  <https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol>
- **KIP-345**, *Static membership*:
  <https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances>
- **Uber**, *Building reliable reprocessing and dead letter queues with Kafka*
  — el diseño de C2, en producción a escala:
  <https://www.uber.com/blog/reliable-reprocessing/>
- **Confluent**, *How to choose the number of partitions*:
  <https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/>
- **Kleppmann**, *DDIA* cap. 11 (*Stream Processing*) — en particular la
  diferencia entre logs y colas, y el replay.

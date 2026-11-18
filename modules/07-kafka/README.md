# Módulo 07 — Kafka a fondo

## Por qué acá

Kafka apareció en todos los módulos anteriores y siempre quedó pendiente:

- **Módulo 02** — el outbox publica en Kafka, y la `key` define el orden.
- **Módulo 03, C3** — *"escalé el consumer de 3 a 12 réplicas y el lag no bajó
  en absoluto"*. La pregunta era: **¿cuántas particiones tiene el topic?**
- **Módulo 06** — at-least-once, rebalances que reprocesan 2.500 mensajes, y
  USD 219.000 al año en llamadas al LLM de más.

Este módulo es la respuesta completa a esos tres. Y arranca por la frase que
hay que decir primero en cualquier entrevista sobre el tema.

## Material de este módulo

| Archivo | Qué es |
| --- | --- |
| Este `README.md` | La teoría |
| [`quiz.md`](quiz.md) · [`respuestas.md`](respuestas.md) | Preguntas de entrevista y respuestas modelo con rúbrica |
| `particiones.ts` · `claves.ts` · `rebalance.ts` | Los ejemplos ejecutables |

## Teoría mínima

### 1. Kafka no es una cola

Es lo primero que hay que entender, porque de ahí sale todo lo demás:

> **Kafka es un log distribuido, append-only, particionado y replicado.**

| | Cola (SQS, RabbitMQ clásico) | **Log (Kafka)** |
| --- | --- | --- |
| Al consumir | **El mensaje se borra** | **El mensaje se queda**; avanzás un puntero |
| Quién lleva la cuenta | El broker, por mensaje | **El consumidor**, con un *offset* |
| Varios consumidores | Compiten: cada mensaje va a uno | **Cada grupo lee todo, independientemente** |
| Reprocesar | Imposible: ya se borró | **Mover el offset para atrás** |
| Ack individual | Sí (`ack`/`nack` por mensaje) | **No**: se commitea una posición |
| Reintentar uno solo | Nativo | **Incómodo** (bloquea la partición, o topic aparte) |

De esa tabla salen las dos razones reales para elegir Kafka —y **ninguna es
el throughput**:

1. **Reproceso y retención.** Podés volver a leer tres meses de histórico
   para reconstruir una proyección o arreglar un bug de un consumidor.
2. **Varios consumidores independientes del mismo stream.** Facturación,
   analytics, notificaciones y búsqueda leen `order.created` cada uno a su
   ritmo, sin saber de los demás.

Si tu argumento para Kafka es "escala mejor" y tenés 200 eventos/s, no tenés
un argumento (módulo 01, D2). **SQS aguanta ráfagas enormes sin tunear nada.**

### 2. Anatomía

```
TOPIC "orders"
├── Partición 0   [0][1][2][3][4][5]──►         offsets, orden GARANTIZADO
├── Partición 1   [0][1][2][3]──►               orden garantizado acá adentro
└── Partición 2   [0][1][2][3][4][5][6][7]──►   y acá adentro

   ENTRE particiones NO hay ningún orden. Ninguno.
```

- **Partición**: un log ordenado e inmutable. Es la unidad de **paralelismo**,
  de **orden** y de **replicación**.
- **Offset**: la posición de un mensaje dentro de **su** partición. No es un id
  global.
- **Réplicas**: cada partición tiene un **leader** (atiende lecturas y
  escrituras) y seguidores. Las que están al día forman el **ISR** (*in-sync
  replicas*).
- **Retención**: por tiempo (7 días por defecto) o por tamaño. Al vencer, se
  borran **segmentos** enteros del log — no mensajes individuales.
- **KRaft**: desde Kafka 4.0 ya no hay ZooKeeper; los metadatos viven en Kafka
  mismo. Si ves tutoriales con ZooKeeper, son de antes.

### 3. La partición es la unidad de paralelismo

**Ésta es LA regla del módulo:**

> **En un consumer group, cada partición la consume exactamente UN consumidor.
> Si tenés más consumidores que particiones, los de más quedan IDLE.**

```
Topic con 3 particiones, consumer group con 6 consumidores:

  P0 ──► C1      C4  ← idle, consumiendo CPU y memoria, sin hacer NADA
  P1 ──► C2      C5  ← idle
  P2 ──► C3      C6  ← idle
```

Eso responde el C3 del módulo 03: escalaste a 12 réplicas, el topic tiene 3
particiones, y **9 pods están vivos, sanos y sin recibir un solo mensaje**. El
HPA incluso puede seguir escalando, porque la CPU promedio baja al agregar
pods ociosos.

**Cuántas particiones elegir.** La cuenta es directa:

```
particiones >= throughput_pico / throughput_por_consumidor
```

Con 1.200 msg/s y 80 ms por mensaje, un consumidor hace `1/0,08 = 12,5 msg/s`.
Necesitás **96 particiones** — no 6, no 12.

Y hay que dimensionar con margen, porque:

> ⚠️ **Las particiones se pueden AUMENTAR, nunca reducir.** Y aumentarlas
> **cambia el mapeo `key → partición`**, lo que rompe el orden por clave
> entre lo viejo y lo nuevo (sección 4).

El costo de pasarse: cada partición es archivos abiertos, memoria en el
broker, metadata en el controlador, y más tiempo de rebalance. Miles de
particiones por cluster están bien; cientos de miles, no. **Regla práctica:
dimensioná para 2-3x tu pico proyectado y quedate ahí.**

**Y el límite que no se arregla con particiones:** si el procesamiento es
lento por una llamada externa, la otra palanca es **concurrencia dentro del
consumidor** (procesar el batch de una partición en paralelo). El costo:
**perdés el orden dentro de la partición** y el manejo de offsets se vuelve
delicado — no podés commitear el offset N hasta que todo ≤ N terminó. Sólo
vale si el procesamiento es idempotente y sin orden (módulo 06).

### 4. La clave decide la partición, y por lo tanto el orden

```
partición = murmur2(key) % numero_de_particiones      // con key
partición = round-robin / sticky                       // con key = null
```

**Consecuencias, en orden de importancia:**

1. **Misma clave → misma partición → orden garantizado.** Si usás
   `key = orderId`, todos los eventos de esa orden llegan en orden. **Es la
   única forma de tener orden en Kafka.**
2. **`key = null` → sin ningún orden.** `order.updated` puede llegar **antes**
   que `order.created`. Si tu consumidor asume el orden, tenés un bug que
   aparece bajo carga.
3. **Elegir mal la clave = partición caliente.** Con `key = tenantId` y un
   tenant que es el 40% del tráfico, **una partición recibe el 40% de los
   mensajes** y su consumidor es el cuello de botella de todo el grupo.
   Agregar particiones **no lo arregla**: esa clave sigue cayendo en una sola.
4. **El orden es por partición, no por topic.** Nunca prometas "orden global"
   en una entrevista: eso sólo existe con **una** partición, o sea sin
   paralelismo.

**Cómo elegir la clave:** la **granularidad más fina que preserve el orden que
el negocio necesita**.

| Clave | Orden que te da | Riesgo de partición caliente |
| --- | --- | --- |
| `null` | Ninguno | Ninguno |
| `orderId` | Por orden | Bajísimo (muchas órdenes) |
| `userId` | Por usuario | Bajo |
| `tenantId` | Por tenant | **Alto** (tenants desparejos) |
| una constante | Total | Garantizado: todo en una partición |

Casi siempre la respuesta correcta es la entidad más chica cuyo orden
importa: `orderId`, no `tenantId`. Lo vas a medir en `claves.ts`.

### 5. Consumer groups y rebalances

Un **consumer group** es un conjunto de consumidores que se reparten las
particiones de un topic. Cada grupo lleva **sus propios offsets**, así que
varios grupos leen el mismo topic sin interferirse.

Un **rebalance** es la reasignación de particiones, y se dispara cuando: entra
o sale un consumidor (**incluido cada deploy**), cambia la cantidad de
particiones, o un consumidor **se considera muerto**.

**Los dos protocolos**, y la diferencia importa mucho:

| | **Eager** (viejo) | **Cooperative sticky** (actual) |
| --- | --- | --- |
| Qué hace | **Todos** devuelven **todas** sus particiones, y se reparte de cero | Sólo se mueven las particiones que hace falta mover |
| Durante el rebalance | **Nadie consume nada**: stop-the-world | Los demás **siguen consumiendo** |
| Con 100 particiones y un deploy | Todo el grupo se detiene | Se mueve una fracción |

Si tu cluster es moderno, usá `CooperativeStickyAssignor`. Es un cambio de una
línea y en un rolling deploy la diferencia es enorme.

**Los tres timeouts que hay que conocer** (son la causa del 90% de los
problemas de rebalance):

| Parámetro | Default | Qué significa |
| --- | --- | --- |
| `heartbeat.interval.ms` | 3 s | Cada cuánto el consumidor dice "estoy vivo" |
| `session.timeout.ms` | 45 s | Sin heartbeat por este tiempo → **muerto** |
| `max.poll.interval.ms` | **5 min** | Si no volvés a llamar a `poll()` en este tiempo → **muerto**, aunque estés enviando heartbeats |

**El `max.poll.interval.ms` es el que muerde.** Los heartbeats van en un hilo
aparte, así que tu consumidor puede estar perfectamente "vivo" mientras tarda
7 minutos procesando un batch — y a los 5 minutos **el grupo lo expulsa**.

Y de ahí sale el **loop de rebalances**, que es el modo de falla clásico:

```
1. El consumidor trae un batch grande y tarda > max.poll.interval
2. El grupo lo expulsa y rebalancea
3. Otro consumidor toma la partición DESDE EL ÚLTIMO OFFSET COMMITEADO
4. Reprocesa los mismos mensajes, tarda lo mismo, lo expulsan también
5. Volver a 1, para siempre. El lag CRECE y nada avanza.
```

Las defensas: bajar `max.poll.records`, subir `max.poll.interval.ms`, o
—mejor— hacer el procesamiento más rápido. Lo vas a ver en `rebalance.ts`.

**Static membership** (`group.instance.id`): le da identidad fija a cada
consumidor, así que un reinicio **no dispara rebalance** si vuelve dentro de
`session.timeout.ms`. Para un `StatefulSet` que se reinicia en cada deploy es
una mejora enorme.

### 6. Offsets: dónde se decide at-least-once vs at-most-once

El offset commiteado dice "hasta acá procesé". Y **cuándo lo commiteás define
la semántica de entrega** (módulo 06):

```ts
// AT-MOST-ONCE: commiteo y después proceso. Si muero en el medio, PIERDO.
await commitOffset(msg.offset);
await procesar(msg);

// AT-LEAST-ONCE: proceso y después commiteo. Si muero, DUPLICO.
await procesar(msg);
await commitOffset(msg.offset);
```

`enable.auto.commit = true` (el default) commitea cada
`auto.commit.interval.ms` (5 s) **en el siguiente `poll()`**. Es cómodo y te
da at-least-once con una ventana de reproceso de hasta 5 segundos de mensajes
— que es exactamente de dónde salían los 2.500 mensajes duplicados del
módulo 06.

**Para controlar la ventana, commits manuales por lote.** Y recordá: la
garantía no está en el commit, **está en que el handler sea idempotente**.

### 7. El productor: durabilidad y orden

```ts
const producer = kafka.producer({
  idempotent: true,        // default desde Kafka 3.0; fuerza acks=all
  maxInFlightRequests: 5,
});
await producer.send({ topic, acks: -1, messages: [{ key, value }] });
```

| Parámetro | Qué hace |
| --- | --- |
| `acks=0` | No espera nada. **Perdés mensajes sin saberlo** |
| `acks=1` | Espera al leader. Si el leader muere antes de replicar, **perdés** |
| **`acks=all` (-1)** | Espera a todo el ISR. **El único seguro** |
| `min.insync.replicas=2` | Con RF=3: tolerás perder 1 réplica y seguís escribiendo |
| `enable.idempotence` | Deduplica **los reintentos del productor** y preserva el orden |
| `linger.ms` / `batch.size` | Batching: más throughput, más latencia |

Dos aclaraciones que se preguntan:

- **El productor idempotente NO te da idempotencia de negocio.** Deduplica
  reintentos del **mismo productor en la misma sesión** por secuencia. Si tu
  servicio publica el mismo evento dos veces desde dos requests distintas,
  son dos mensajes distintos. La idempotencia de negocio es la del módulo 06.
- **`max.in.flight.requests.per.connection > 1` con reintentos puede
  reordenar**... salvo con `enable.idempotence=true`, que preserva el orden
  hasta 5 requests en vuelo. Por eso el default moderno está bien.

### 8. El lag es la métrica de saturación

```
lag = último offset de la partición − offset commiteado
```

> **El consumer lag es, de todas las métricas de tu sistema, la mejor señal de
> saturación**, porque mide directamente el desbalance entre lo que producís y
> lo que consumís. Es *leading*, no *lagging*: crece **antes** de que algo
> falle.

Tres reglas para usarlo bien:

1. **Alertá sobre la tendencia, no sobre el valor.** Un lag de 50.000 que baja
   está sano; uno de 500 que sube sin parar es un incidente.
2. **Mirá el lag POR PARTICIÓN, no el total.** El total promediado esconde el
   caso más común: una partición caliente con lag creciente y 95 sanas. Si
   sólo mirás el agregado, no lo ves nunca.
3. **Es la métrica correcta para autoescalar** consumidores (KEDA escala por
   lag de forma nativa) — mucho mejor que la CPU, por todo lo del módulo 03.

Y el lag en **tiempo** (cuántos segundos atrás estoy) suele ser más útil para
el negocio que el lag en mensajes.

### 9. Retención y compactación

Dos políticas (`cleanup.policy`):

- **`delete`** (default): se borran segmentos más viejos que `retention.ms`.
  Para eventos: *"pasó esto"*.
- **`compact`**: Kafka conserva **el último valor de cada clave**, para
  siempre. Para estado: *"el valor actual de X es Y"*.

```
Antes de compactar:  (u1,"Ana") (u2,"Beto") (u1,"Ana M.") (u2,null) (u3,"Caro")
Después:             (u1,"Ana M.")          (u3,"Caro")
                      ↑ sólo el último       ↑ u2 se borró con el "tombstone"
```

Un valor `null` es un **tombstone**: marca la clave como borrada. Es lo que
hace posible un topic como tabla, y es la base de las *KTable* de Kafka
Streams y de los conectores de CDC (módulo 02).

### 10. Kafka vs el resto, en AWS

| Necesidad | Elegí |
| --- | --- |
| Sacar trabajo del request, ráfagas, reintentos por mensaje, DLQ nativa | **SQS** |
| Fan-out simple a varios suscriptores | **SNS + SQS** |
| Ruteo por contenido, integración entre servicios de AWS, schema registry | **EventBridge** |
| Orden por clave + reproceso histórico + varios consumidores independientes | **Kafka / MSK** |
| Trabajos con prioridades, reintentos y programación (mails, PDFs, LLM) | **Una cola de jobs** (BullMQ, SQS). No es lo mismo que un log de eventos |

**MSK te evita operar brokers, no te evita la complejidad conceptual** —
particiones que no se pueden reducir, rebalances, offsets, lag— **que es la
parte cara.** Si el equipo no va a aprender eso, SQS es una decisión más
honesta.

### 11. Aplicado a tu stack

- **NestJS**: `@EventPattern` para consumir, `emit()` para publicar. Y lo del
  módulo 02: **`send()` sobre Kafka es RPC, no es asíncrono** — crea un topic
  de respuesta y espera.
- **`@nestjs/microservices` te esconde el consumidor**, y con él
  `max.poll.records`, los commits manuales y el assignor. Para cualquier
  consumidor serio, conviene usar `kafkajs` directo o un servicio propio.
- **Poison pill**: un mensaje que falla siempre. Sin manejo, **bloquea la
  partición para siempre** — y con ella todos los mensajes detrás. La
  solución es *retry topics* con delay creciente + DLQ, porque Kafka no tiene
  DLQ nativa.
- **Un consumidor por partición significa que tu concurrencia útil está
  acotada por las particiones**, no por los pods (módulo 03).
- **Agentes de IA** (módulo 14): un topic de inferencia con `key = conversationId`
  te da orden por conversación y paralelismo entre conversaciones. Y el lag
  es tu métrica de saturación frente al rate limit del proveedor.

## Lo que vas a correr

```bash
node modules/07-kafka/particiones.ts
node modules/07-kafka/claves.ts
node modules/07-kafka/rebalance.ts
```

1. **`particiones.ts`** — el techo de throughput de un consumer group según
   particiones y consumidores. Resuelve numéricamente el C3 del módulo 03 y
   muestra por qué escalar de 3 a 12 réplicas no cambia nada.
2. **`claves.ts`** — distribución de mensajes entre particiones con
   `key = null`, `tenantId` y `orderId` sobre tráfico Zipf. Mirá el lag por
   partición: con `tenantId`, una partición se come todo.
3. **`rebalance.ts`** — qué cuesta un rebalance: eager vs cooperative, y el
   loop de rebalances cuando el batch tarda más que `max.poll.interval.ms`.

## Para pensar / próximo paso

- Tu topic tiene 12 particiones con `key = tenantId`. Un tenant nuevo pasa a
  ser el 50% del tráfico. ¿Qué pasa? ¿Agregar particiones lo arregla? ¿Qué
  hacés?
- Un mensaje falla siempre (JSON corrupto). ¿Qué le pasa a su partición?
  ¿Cómo lo resolvés sin perder el mensaje ni bloquear los que vienen detrás?
- Necesitás reprocesar 3 meses de eventos para reconstruir una proyección,
  **sin** afectar a los consumidores actuales ni duplicar efectos. ¿Cómo lo
  hacés?

## Fuentes

- **Kafka**, *Design* y *Implementation* — la documentación oficial es
  inusualmente buena: <https://kafka.apache.org/documentation/#design>
- **Kafka**, *Consumer configs* (los tres timeouts de la sección 5):
  <https://kafka.apache.org/documentation/#consumerconfigs>
- **KIP-429**, *Incremental Cooperative Rebalancing*:
  <https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol>
- **KIP-345**, *Static membership*:
  <https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances>
- **Confluent**, *How to choose the number of partitions*:
  <https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/>
- **Uber**, *Building reliable reprocessing and dead letter queues with Kafka*:
  <https://www.uber.com/blog/reliable-reprocessing/>
- **Kleppmann**, *DDIA* cap. 11 (*Stream Processing*).

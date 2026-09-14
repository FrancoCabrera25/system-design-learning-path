# Outbox con Kafka, RabbitMQ o Redis Streams

> *"He visto mucho usar Redis Streams: llega un evento y eso llama a guardar
> en la base. El patrón outbox es al revés: guardar y después publicar el
> evento. ¿Cuál está bien?"*

**Los dos.** No son alternativas en conflicto: son **las dos puntas del mismo
tubo**. Esa confusión es tan común que vale la pena empezar por ahí, antes de
comparar brokers.

---

## 1. Dos flechas distintas, no dos opiniones

```
   ══════════════ EL LADO PRODUCTOR ══════════════
                                                      ┌───────────┐
   Tu servicio cambia estado  ──────────────────────► │  BROKER   │
   y tiene que publicar un evento                     │  (Kafka / │
                                                      │  Rabbit / │
   PROBLEMA: dos escrituras (base + broker)           │  Redis)   │
             sin transacción que las abarque          │           │
   SOLUCIÓN: OUTBOX                                   │           │
                                                      │           │
   ══════════════ EL LADO CONSUMIDOR ═════════════    │           │
                                                      │           │
   Llega un evento ─────────────────────────────────► │           │
   y hay que guardarlo / procesarlo                   └───────────┘
                                                            │
   PROBLEMA: dos escrituras (efecto + commit del offset)    │
             sin transacción que las abarque                ▼
   SOLUCIÓN: CONSUMIDOR IDEMPOTENTE (a veces "inbox")   Base de datos
```

Lo que viste —*"llega un evento y eso llama a guardar en la base"*— es el
**lado consumidor**. El outbox es el **lado productor**. En un sistema con
varios servicios, los dos ocurren todo el tiempo:

```
Servicio A                        Servicio B
──────────────────────────        ──────────────────────────
guarda orden + outbox    ──►  Kafka  ──►   consume el evento
(patrón OUTBOX)                            y guarda en SU base
                                           (CONSUMIDOR IDEMPOTENTE)
                                                   │
                                           guarda + outbox  ──► Kafka ──► ...
                                           (OUTBOX otra vez)
```

**El mismo servicio suele necesitar los dos patrones**: idempotencia al
recibir, outbox al emitir. Y no es casualidad: son el mismo problema —
*dos escrituras que deberían ser atómicas y no lo son*— visto desde cada lado.

Ahora bien, hay un caso donde efectivamente **no hace falta outbox**, y es
probablemente lo que estabas viendo. Va la sección 2.

---

## 2. La alternativa real: "log primero" (y por qué a veces es mejor)

Hay una arquitectura donde el evento se escribe **antes** que la base, a
propósito:

| | **A — Base primero (outbox)** | **B — Log primero (event-first)** |
| --- | --- | --- |
| El request escribe | La base (dato + outbox), en 1 transacción | **Sólo el log** (`XADD` / `produce`) |
| Quién escribe la base | El mismo request | Un consumidor, después |
| Fuente de verdad | **La base** | **El log** |
| Escrituras en el camino crítico | 1 transacción (2 filas) | **1 sola escritura** |
| ¿Necesita outbox? | Sí | **No: no hay doble escritura que hacer** |
| Lectura después de escribir | Inmediata y consistente | **Eventual** (el dato aparece "en un rato") |
| ¿Puede rechazar por estado? | **Sí**: "no hay stock" en la misma request | **No**: no conoce el estado actual |
| Respuesta al cliente | `201 Created` con el recurso | `202 Accepted` con un id |

**La clave está en la fila "¿necesita outbox?".** El outbox existe para
resolver **el problema de la doble escritura**. Si diseñás el flujo para que
haya **una sola escritura**, el problema no existe y el outbox sobra.

```ts
// B — Log primero. No hay outbox porque no hay doble escritura.
@Post('mensajes')
async recibir(@Body() dto: MensajeDto) {
  const id = ulid();
  await this.redis.xadd('mensajes', '*', 'id', id, 'payload', JSON.stringify(dto));
  return { id, status: 'accepted' };           // 202, en ~2 ms
}

// El consumidor materializa a Postgres, idempotentemente
@OnStream('mensajes')
async materializar(ev: Evento) { /* INSERT ... ON CONFLICT DO NOTHING */ }
```

### Cuándo cada una

**Usá "log primero" (B) cuando el sistema ACEPTA y después procesa:**

- Ingesta de telemetría, clicks, logs, métricas.
- Mensajes de chat, comentarios, reacciones.
- Webhooks entrantes (Stripe, GitHub): **hay que responder 200 rápido o el
  proveedor reintenta**; guardás el evento crudo en el log y procesás después.
- Cualquier cosa donde el volumen de escritura sea muy alto y la validación
  contra estado sea innecesaria.

**Usá "base primero + outbox" (A) cuando el sistema DECIDE:**

- Hay que **rechazar** por estado: sin stock, saldo insuficiente, email ya
  registrado, asiento ya reservado.
- El usuario tiene que ver su cambio **inmediatamente** (read-your-writes).
- Hay invariantes que sólo la base puede garantizar (un `UNIQUE`, un
  `CHECK`, un saldo que no puede quedar negativo).

**El test de una pregunta:**

> **¿Esta operación puede fallar por el estado actual del sistema?**
> Si sí → base primero, con outbox. Si no → log primero, sin outbox.

Un `POST /orders` que valida stock **no puede** ser log-first: para decir "no
hay stock" necesitás leer el stock, y el stock vive en la base. Un
`POST /events` de analytics **nunca** falla por estado: aceptalo y seguí.

*(Y ojo con la trampa: "log primero" no significa "sin validación". Validás
formato, autenticación y permisos sincrónicamente. Lo que no podés validar es
el estado del dominio.)*

---

## 3. El outbox es agnóstico del broker

Lo primero que hay que entender de la comparación: **la parte que importa del
outbox es idéntica en los tres**, porque el problema está del lado de
Postgres, no del broker.

```sql
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  aggregate_id  uuid        NOT NULL,
  topic         text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE INDEX idx_outbox_pendientes ON outbox (id) WHERE published_at IS NULL;
```

```ts
// Esto NO cambia entre Kafka, RabbitMQ y Redis Streams:
await this.dataSource.transaction(async (tx) => {
  await tx.save(Order, orden);
  await tx.save(OutboxEvent, { aggregateId: orden.id, topic: 'order.created', payload });
});
```

**Ningún broker puede participar de una transacción de Postgres.** Ni Kafka
con sus "transacciones" (que son *dentro de Kafka*: consumir-transformar-
producir, no a través de tu base), ni RabbitMQ, ni Redis con `MULTI/EXEC`.
Por eso el outbox es necesario con los tres.

Lo que cambia es **el publisher** (30 líneas) y, sobre todo, **las garantías
que te da cada broker una vez que el evento salió**.

---

## 4. Lo que sí cambia

| | **Kafka** | **RabbitMQ** | **Redis Streams** |
| --- | --- | --- | --- |
| **Modelo** | Log distribuido append-only | Broker de colas con routing | Log append-only en memoria |
| **Durabilidad por defecto** | Disco + réplicas (`acks=all` + `min.insync.replicas`) | Disco si el mensaje es `persistent` **y** la cola es `durable` | **RAM.** AOF `everysec` → **hasta 1 s de escrituras perdidas en una caída** |
| **Confirmación al publicar** | `acks=all` (esperás a las réplicas) | **Publisher confirms** — sin esto, publicar es fire-and-forget | `XADD` devuelve el id, pero sólo confirma que llegó a la RAM del primario |
| **Replicación** | Síncrona configurable (ISR) | Quorum queues (Raft) | **Asíncrona**: un failover puede perder escrituras ya confirmadas |
| **Retención / replay** | **Días o meses.** Reprocesás desde cualquier offset | El mensaje se borra al hacer ack (las *streams* de Rabbit sí retienen) | Configurable con `MAXLEN`/`MINID`, **acotado por la RAM** |
| **Ack por mensaje** | No: se commitea un **offset** (avanza en bloque) | **Sí**, individual (`ack`/`nack`/`reject`) | **Sí**, individual (`XACK`) + PEL de pendientes |
| **Reintento de uno solo** | Incómodo: bloquea la partición o lo reencolás en otro topic | **Nativo**: `nack` + requeue, con dead-letter exchange | `XPENDING` + `XAUTOCLAIM` lo reclama tras un timeout |
| **DLQ** | A mano (topic aparte) | **Nativo** (dead-letter exchange) | A mano (otro stream) |
| **Orden** | Garantizado **por partición** | Por cola con un solo consumidor | Total en el stream; **se pierde** al repartir en un consumer group |
| **Varios consumidores independientes del mismo evento** | **Sí**: N consumer groups, cada uno con su offset | Requiere un fanout exchange y N colas | Sí: N consumer groups |
| **Throughput** | Altísimo (cientos de miles/s) | Alto (decenas de miles/s) | Muy alto, **limitado por RAM** |
| **Costo operativo** | **Alto** (o MSK, que igual no te ahorra la complejidad conceptual) | Medio | **Bajo: ya tenés Redis** |

### Las tres diferencias que de verdad deciden

**1. Durabilidad.** Es la más importante y la que menos se mira. Redis, con
su configuración por defecto (`appendfsync everysec`), puede perder **hasta un
segundo de escrituras** si el proceso muere, y su replicación asíncrona puede
perder escrituras ya confirmadas en un failover. Para una cola de trabajos o
un pipeline de analytics, perfecto. Para `order.created` o `payment.succeeded`
— eventos que representan **dinero o compromisos con el cliente** — tenés que
saber que ese riesgo existe y decidirlo a conciencia, no heredarlo del default.

Y notá la ironía: **te tomaste el trabajo de hacer un outbox para no perder
ningún evento, y lo publicás en un broker que puede perderlo.** Si vas a usar
Redis Streams para eventos críticos, `appendfsync always` (más lento) y
asumir que el failover puede costarte algo.

**2. Retención y reproceso.** Ésta es *la* razón para elegir Kafka. Si dentro
de seis meses necesitás reconstruir una proyección, corregir un bug en un
consumidor y reprocesar tres meses de eventos, o agregar un servicio nuevo que
necesita todo el histórico — **sólo Kafka te lo da sin pensarlo**. En
RabbitMQ el mensaje se borró al hacer ack. En Redis Streams lo tenés hasta
donde te dé la RAM.

**3. Granularidad del ack y el reintento.** Acá RabbitMQ gana cómodo, y es
algo que se subestima. Con offsets de Kafka, un mensaje envenenado en el medio
de una partición es un dolor: o bloqueás la partición reintentando, o lo
salteás y lo mandás a un topic de reintentos (que hay que construir).
RabbitMQ te da `nack` + dead-letter exchange sin escribir nada. Redis Streams
está en el medio: el PEL (*pending entries list*) y `XAUTOCLAIM` te dejan
recuperar mensajes de un consumidor muerto, y el contador de entregas
(`XPENDING`) te permite mandarlo a una DLQ vos mismo.

---

## 5. El mismo publisher, con los tres

La tabla `outbox` y la transacción son idénticas. Sólo cambia esto:

### Kafka (kafkajs)

```ts
private readonly producer = this.kafka.producer({
  idempotent: true,                  // dedup de reintentos DENTRO de la sesión
  maxInFlightRequests: 5,
});

async publicarLote(eventos: OutboxEvent[]) {
  await this.producer.send({
    topic: 'orders',
    acks: -1,                        // -1 = all: esperar a las réplicas ISR
    messages: eventos.map((e) => ({
      key: e.aggregateId,            // <-- define la PARTICIÓN, o sea el ORDEN
      value: JSON.stringify(e.payload),
      headers: { eventId: String(e.id), eventType: e.topic },
    })),
  });
}
```

El detalle que define el diseño: **`key` decide la partición**. Todos los
eventos de la misma orden van a la misma partición y por lo tanto **llegan en
orden**. Si ponés `key: null`, se reparten round-robin y `order.updated` puede
llegar antes que `order.created`. Es la decisión más importante del módulo 07.

### RabbitMQ (amqplib)

```ts
// El canal DEBE estar en modo confirm, si no publicar no garantiza nada
const canal = await conexion.createConfirmChannel();
await canal.assertExchange('orders', 'topic', { durable: true });

async publicarLote(eventos: OutboxEvent[]) {
  for (const e of eventos) {
    canal.publish('orders', e.topic, Buffer.from(JSON.stringify(e.payload)), {
      persistent: true,              // delivery_mode=2 -> va a disco
      messageId: String(e.id),       // para deduplicar del otro lado
      contentType: 'application/json',
    });
  }
  await canal.waitForConfirms();     // <-- SIN ESTO, publicar es fire-and-forget
}
```

**`createConfirmChannel()` + `waitForConfirms()` es obligatorio.** Sin eso,
`publish()` devuelve `true` apenas escribió en el socket: si el broker se
cae en ese instante, el mensaje se evaporó **y vos marcaste la fila del
outbox como publicada**. Es el error #1 con RabbitMQ y anula todo el trabajo
del outbox.

Igual de obligatorio: `durable: true` en el exchange y la cola, **y**
`persistent: true` en el mensaje. Los tres. Si falta uno, el mensaje no
sobrevive a un reinicio del broker.

### Redis Streams (ioredis)

```ts
async publicarLote(eventos: OutboxEvent[]) {
  const pipeline = this.redis.pipeline();
  for (const e of eventos) {
    pipeline.xadd(
      `stream:${e.topic}`,
      'MAXLEN', '~', '1000000',      // trimming aproximado: acota la RAM
      '*',                            // id autogenerado (timestamp-secuencia)
      'eventId', String(e.id),
      'aggregateId', e.aggregateId,
      'payload', JSON.stringify(e.payload),
    );
  }
  await pipeline.exec();
}
```

Y del lado del consumidor, que es donde Redis Streams se pone interesante:

```ts
// Consumer group: reparte entre consumidores y lleva la lista de pendientes
await redis.xgroup('CREATE', 'stream:orders', 'facturacion', '0', 'MKSTREAM');

while (true) {
  const res = await redis.xreadgroup(
    'GROUP', 'facturacion', `worker-${podId}`,
    'COUNT', 100, 'BLOCK', 5000,
    'STREAMS', 'stream:orders', '>',
  );

  for (const [, entradas] of res ?? []) {
    for (const [id, campos] of entradas) {
      await this.procesarIdempotente(campos);
      await redis.xack('stream:orders', 'facturacion', id);   // ack individual
    }
  }

  // Rescatar lo que quedó colgado de un worker que se murió
  await redis.xautoclaim('stream:orders', 'facturacion', `worker-${podId}`, 60_000, '0');
}
```

`XAUTOCLAIM` (Redis 6.2+) es la pieza que mucha gente no usa: si un worker
muere después de leer y antes del `XACK`, el mensaje queda en el **PEL**
(*pending entries list*) para siempre. Sin un `XAUTOCLAIM` periódico, **esos
mensajes no los procesa nadie nunca** y no hay ningún error que lo delate.
Es el equivalente a la alerta de antigüedad del outbox: hay que monitorear
`XPENDING`.

---

## 6. Cómo elegir

| Situación | Elegí |
| --- | --- |
| Ya tenés Redis, el volumen es moderado, y perder algo en un caso extremo no es catastrófico | **Redis Streams** |
| Necesitás reintentos por mensaje, DLQ y routing complejo, sin operar Kafka | **RabbitMQ** |
| Necesitás **reproceso histórico**, varios consumidores independientes del mismo stream, orden garantizado por clave, o volumen muy alto | **Kafka** |
| El "evento" es en realidad un **trabajo** con reintentos, prioridades y programación (mandar mails, generar PDFs, llamar al LLM) | **Una cola de jobs** (BullMQ sobre el Redis que ya tenés, o SQS). No confundas una cola de trabajos con un log de eventos |
| Estás en AWS y no querés operar nada | **SQS/SNS/EventBridge** para colas y ruteo; **MSK** sólo si de verdad necesitás Kafka |

Y una observación que vale para las cinco filas: **casi nadie necesita Kafka
por throughput.** Se necesita por **retención y reproceso**, o por tener
varios consumidores independientes del mismo stream. Si tu argumento para
Kafka es "escala mejor" y tenés 200 eventos/s, no tenés un argumento
(módulo 01, D2).

---

## 7. El caso especial donde el outbox no hace falta

El outbox existe porque tu **estado** y tu **broker** son dos sistemas
distintos sin una transacción común. Si dejan de ser dos sistemas distintos,
el problema desaparece:

**a) Si tu estado vive en Redis y publicás en Redis Streams**, `MULTI/EXEC`
sí es atómico entre los dos:

```ts
await redis.multi()
  .hset(`orden:${id}`, 'estado', 'CREADA')
  .xadd('stream:orders', '*', 'eventId', id, 'payload', json)
  .exec();                          // <-- atómico de verdad
```

Es la única combinación donde el outbox sobra por construcción. (Con las
advertencias de durabilidad de la sección 4: atómico no es lo mismo que
durable.)

**b) Si el log ES tu fuente de verdad** (event sourcing, o el "log primero"
de la sección 2): hay una sola escritura, no hay nada que sincronizar.

**c) Si usás CDC sobre tus tablas de negocio directamente**, sin tabla
`outbox`: Debezium publica cada cambio de `orders`. Funciona, y el costo es
que tus eventos pasan a ser **filas de tu esquema interno** en vez de
**eventos de dominio** que vos diseñaste. Cada refactor de la tabla rompe a
los consumidores. Por eso, incluso con CDC, **mucha gente mantiene la tabla
`outbox` y le apunta Debezium ahí**: te da la latencia de CDC con eventos
que vos controlás. Es, probablemente, la mejor combinación disponible hoy.

---

## 8. Los errores que más se ven

1. **Publicar sin confirmación.** `channel.publish()` sin confirm channel, o
   `producer.send()` con `acks: 0`. Marcás el outbox como publicado y el
   evento nunca existió. **Anula el patrón entero.**
2. **Usar Redis Streams con el default de durabilidad para eventos de
   dinero.** No está mal: está sin decidir. Decidilo.
3. **Publicar dentro de la transacción.** Si el `COMMIT` falla después,
   publicaste un evento sobre una orden que no existe. Cambiaste "evento
   perdido" por "evento fantasma", que es peor (módulo 02, `para-pensar` C4).
4. **Confundir el patrón con el broker.** "Usamos Kafka, así que no
   necesitamos outbox" — Kafka no participa de tu transacción de Postgres.
5. **No monitorear los pendientes.** El `outbox` sin publicar y el `XPENDING`
   de Redis Streams son la misma alerta: *"hay trabajo que nadie está
   haciendo y nadie se entera"*.
6. **Un consumidor no idempotente.** Los tres brokers son at-least-once. El
   outbox **garantiza** duplicados (republica si muere entre el publish y el
   update). Sin consumidor idempotente, el outbox te cambia "perder eventos"
   por "procesarlos dos veces".

---

## 9. Probalo

```bash
node modules/02-comunicacion-servicios/dual-write.ts
```

Simula 200.000 operaciones con una probabilidad realista de que el proceso
muera en el peor momento, y compara cuatro diseños —publicar primero, guardar
primero, outbox, y log primero— contando **eventos perdidos, eventos
fantasma, duplicados e inconsistencias**. Ver la columna de "inconsistencias
permanentes" al lado de la de "duplicados" deja clarísimo cuál es el
intercambio que estás firmando con cada uno.

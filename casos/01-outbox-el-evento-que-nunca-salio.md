# Caso 01 — El evento que nunca salió

> **Módulos:** [02 (comunicación)](../modules/02-comunicacion-servicios/) ·
> [06 (idempotencia)](../modules/06-idempotencia/)
> **Patrón:** Transactional Outbox

---

## 1. El escenario

Un e-commerce con microservicios en NestJS. El servicio de **órdenes** recibe
`POST /orders`, guarda la orden en su Postgres y publica `order.created` en
Kafka. Los servicios de **logística**, **facturación** y **notificaciones**
consumen ese evento.

```
55 escrituras/s (4,8 millones de órdenes por día)
12 pods del servicio de órdenes
~20 caídas de proceso por día entre todos (deploys, OOM, spot, drenaje de nodos)
```

El código, que es el que escribe todo el mundo:

```ts
@Post()
async create(@Body() dto: CreateOrderDto) {
  const orden = await this.repo.save({ ...dto, estado: 'CONFIRMADA' });
  await this.kafka.emit('order.created', { orderId: orden.id, ...dto });
  return orden;
}
```

## 2. Qué se rompe

**El síntoma:** soporte reporta, cada tanto, órdenes que el cliente pagó y que
**nunca salieron del depósito**. La orden está perfecta en la base: estado
`CONFIRMADA`, con su fecha, su monto, todo. Pero logística nunca la vio.

Y lo que lo hace difícil: **no hay ningún error en ningún log.** El `POST`
devolvió 201. La transacción commiteó. Kafka está sano. Los consumidores están
sanos y con lag cero. Todo verde.

**La causa:** entre las dos líneas hay una ventana.

```
await this.repo.save(...)    ✅ COMMIT: la orden existe para siempre
💥  el pod muere acá  (deploy, OOM kill, spot interruption, nodo drenado)
await this.kafka.emit(...)   ❌ nunca se ejecutó, y nadie lo va a reintentar
```

Son **dos escrituras en dos sistemas distintos sin una transacción que las
abarque**. Esa ventana dura lo que tarda el `emit` — unos milisegundos — y
"unos milisegundos" suena a nada.

Corré [`dual-write.ts`](../modules/02-comunicacion-servicios/dual-write.ts)
para ver la cuenta. Con esos números:

```
guardar -> publicar     8 eventos perdidos por día     = 2.920 por año
```

**2.920 órdenes al año que existen y que nadie procesa.** Y el modo de falla
es el peor posible: silencioso, permanente, y sin forma de reconstruir qué se
perdió.

Y ojo con la tentación de invertir el orden:

```ts
await this.kafka.emit(...);     // publicar primero
await this.repo.save(...);      // 💥 si el COMMIT falla...
```

Eso es **peor**. Ahora publicaste un evento sobre una orden que **no existe**:
logística reserva stock, facturación emite una factura y notificaciones manda
un mail, todo sobre un `orderId` que no está en ninguna tabla. Cambiaste
"evento perdido" (malo, reconciliable) por **"evento fantasma"** (peor: no hay
ninguna fila contra la cual reconciliar). En la simulación son 13 por día.

## 3. La solución probada

**Transactional Outbox.** El evento no se publica: **se escribe como una fila
más, en la misma transacción que el dato.**

```
┌──────── UNA transacción de Postgres ────────┐
│  BEGIN                                       │
│    INSERT INTO orders (...)                  │
│    INSERT INTO outbox (...)   <- el evento   │
│  COMMIT                                      │
└──────────────────────────────────────────────┘
                   │
                   ▼  un proceso APARTE lo lee y publica
                 Kafka
```

Postgres garantiza que **o quedan las dos filas o no queda ninguna**. No
existe un estado donde la orden exista y el evento no.

Está documentado por Chris Richardson en `microservices.io`, es el patrón que
usan Debezium y Confluent en su guía oficial de CDC, y lo implementan por
defecto frameworks como Eventuate y Axon. **No es una idea: es el consenso de
la industria sobre este problema.**

## 4. La implementación

### El esquema

```sql
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  aggregate_id  uuid        NOT NULL,       -- para usar como key de Kafka
  topic         text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

-- LA PIEZA CLAVE: índice PARCIAL sobre las filas pendientes.
-- Contiene decenas de filas, no millones, aunque la tabla tenga 500M.
CREATE INDEX idx_outbox_pendientes ON outbox (id) WHERE published_at IS NULL;
```

Ese `WHERE` es la diferencia entre un patrón que funciona durante años y un
incidente programado. Sin él, la query del publisher es un *seq scan* sobre
una tabla que crece para siempre
([módulo 02, apéndice A.2](../modules/02-comunicacion-servicios/para-pensar.md)).

### La escritura

```ts
@Post()
async create(@Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string) {
  return this.dataSource.transaction(async (tx) => {
    const orden = await tx.save(Order, { ...dto, estado: 'CONFIRMADA' });

    await tx.save(OutboxEvent, {
      aggregateId: orden.id,
      topic: 'order.created',
      payload: { orderId: orden.id, total: orden.total, items: orden.items },
    });

    return orden;        // el COMMIT de la transacción cierra las dos cosas
  });
}
```

### El publisher

**Un proceso aparte. No tus 12 pods de la API.**

```ts
@Injectable()
export class OutboxPublisher {
  @Interval(200)
  async publicar() {
    await this.dataSource.transaction(async (tx) => {
      const pendientes = await tx.query(`
        SELECT id, aggregate_id, topic, payload
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `);
      if (pendientes.length === 0) return;

      await this.producer.send({
        topic: 'orders',
        acks: -1,                                  // esperar al ISR completo
        messages: pendientes.map((e) => ({
          key: e.aggregate_id,                     // define la partición = el ORDEN
          value: JSON.stringify(e.payload),
          headers: { eventId: String(e.id), eventType: e.topic },
        })),
      });

      await tx.query(
        `UPDATE outbox SET published_at = now() WHERE id = ANY($1)`,
        [pendientes.map((e) => e.id)],
      );
    });
  }
}
```

`FOR UPDATE SKIP LOCKED` es lo que permite correr **varios** publishers sin
pisarse y **sin ningún lock distribuido** — es la cláusula de Postgres que
hace que este patrón escale.

### La latencia, sin pollear agresivo

```sql
CREATE OR REPLACE FUNCTION notificar_outbox() RETURNS trigger AS $$
BEGIN PERFORM pg_notify('outbox', ''); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
  FOR EACH ROW EXECUTE FUNCTION notificar_outbox();
```

```ts
await this.pg.query('LISTEN outbox');
this.pg.on('notification', () => this.debounce(20, () => this.publicar()));
setInterval(() => this.publicar(), 5_000);    // red de seguridad: NOTIFY es best-effort
```

Latencia de decenas de milisegundos en vez de 100-200 ms, sin subir la carga.
El `setInterval` lento queda igual: si el publisher estaba reconectando, se
pierde el aviso.

### La limpieza

```sql
-- La outbox es una BANDEJA DE SALIDA, no un historial.
-- Particionada por día, se dropea; nunca se borra fila por fila.
DROP TABLE outbox_2026_11_18;
```

### El consumidor idempotente — **no es opcional**

```ts
@EventPattern('order.created')
async handle(@Payload() ev: OrderCreated, @Ctx() ctx: KafkaContext) {
  const eventId = ctx.getMessage().headers.eventId.toString();

  await this.dataSource.transaction(async (tx) => {
    const insert = await tx.createQueryBuilder()
      .insert().into(ProcessedEvent).values({ eventId })
      .orIgnore()                                  // ON CONFLICT DO NOTHING
      .execute();

    if (insert.identifiers.length === 0) return;   // ya procesado: salimos

    await tx.save(Shipment, { orderId: ev.orderId, estado: 'RESERVADO' });
  });
}
```

**El outbox garantiza duplicados.** Si el publisher muere entre el `send` y el
`UPDATE`, republica. Y no se puede evitar: invertir el orden convierte
"duplicado" en "perdido", que es peor. Por eso **el outbox y el consumidor
idempotente son el mismo patrón** — uno no sirve sin el otro
([módulo 06](../modules/06-idempotencia/)).

## 5. Por qué así y no de otra forma

### ❌ "Publicá dentro de la transacción"

```ts
await this.dataSource.transaction(async (tx) => {
  await tx.save(Order, orden);
  await this.kafka.emit('order.created', ...);   // ← adentro del BEGIN
});
```

**No resuelve nada y empeora el modo de falla.** Kafka no participa de la
transacción de Postgres: el `emit` sale en el momento en que lo llamás. Si
después el `COMMIT` falla (deadlock, violación de constraint, caída de la
base), tenés el **evento fantasma**: publicaste un evento sobre una orden que
no existe.

Cambiaste un fallo reconciliable por uno que no lo es.

### ❌ "Usá una transacción distribuida (2PC)"

Técnicamente resolvería la atomicidad. En la práctica:

- **Kafka no lo soporta** de esa forma. Sus transacciones son *dentro* de
  Kafka (consumir → transformar → producir), no a través de tu base.
- Es **bloqueante**: los participantes retienen locks hasta que el coordinador
  decide, lo que destruye el throughput.
- El **coordinador es un punto único de falla** y, si se cae en la fase de
  commit, los participantes quedan en un estado indeterminado del que sólo se
  sale a mano.

**La respuesta de la industria a este problema es el outbox, no 2PC.** Vale
saber nombrar 2PC en una entrevista y saber por qué se descarta.

### ❌ "Reintentá el `emit` con backoff"

Ayuda con los fallos **del broker** (Kafka no responde) y no con el problema
real: **el proceso muere**. Si el pod desaparece, no hay nadie para ejecutar
el reintento. El estado en memoria se fue con él.

Sirve como complemento, no como solución.

### ❌ "Que el consumidor haga polling de la tabla `orders`"

Funciona —es, de hecho, una variante válida— y tiene dos costos:

1. **Acopla al consumidor con tu esquema interno.** Logística pasa a depender
   de las columnas de **tu** tabla `orders`. Cada refactor tuyo rompe su
   código. El outbox publica **eventos de dominio que vos diseñás**, con su
   propio contrato versionable ([módulo 02, §6](../modules/02-comunicacion-servicios/README.md)).
2. **No escala a varios consumidores**: cada uno necesita su propio cursor
   sobre tu base, y todos leen tu base.

### ⚠️ "Usá CDC (Debezium) directamente sobre `orders`"

Ésta sí es una alternativa seria, y tiene un trade-off real:

| | Outbox + polling | CDC sobre `orders` |
| --- | --- | --- |
| Latencia | Intervalo/2, o ms con `NOTIFY` | Milisegundos |
| Infra | **Ninguna** | Kafka Connect + Debezium + slot de replicación |
| Qué publica | **Eventos que vos diseñás** | **Filas de tu esquema interno** |
| Riesgo operativo | Bajo y obvio | Un slot atascado **le llena el disco a la base** |

Ese último punto se descubre tarde: Postgres no puede borrar el WAL que un
slot de replicación no consumió. Si Debezium se cae un fin de semana y nadie
mira, **la base deja de aceptar escrituras**. Agregaste un componente que, al
fallar, te tumba lo que venías protegiendo.

**La mejor combinación disponible hoy** —y la que usan varios equipos en
serio— es la híbrida: **mantener la tabla `outbox` y apuntarle Debezium a
ella**. Latencia de CDC, eventos que vos controlás.

### ✅ Y cuándo NO hace falta outbox

El outbox resuelve **la doble escritura**. Si no hay dos escrituras, es
complejidad gratis:

- **Sólo publicás, no guardás nada tuyo** (un gateway que reenvía un webhook):
  publicá directo.
- **Sólo guardás, nadie necesita enterarse**: transacción normal.
- **El log ES tu fuente de verdad** (*log primero*, con `202 Accepted`): hay
  una sola escritura. Pero entonces **no podés rechazar por estado** ni dar
  read-your-writes ([`outbox-cuando.md`](../modules/02-comunicacion-servicios/outbox-cuando.md)).

## 6. Cómo sabés que funciona

**La alerta que no puede faltar — y es sobre la ANTIGÜEDAD, no la cantidad:**

```sql
SELECT now() - min(created_at) AS lag_outbox
FROM outbox WHERE published_at IS NULL;
```

Umbral en segundos. **Si el publisher se muere, las órdenes se siguen creando
perfectamente, nadie ve un error, y los envíos no se reservan nunca.** Sin
esta alerta te enterás por un cliente, tres días después — que es exactamente
el problema que vinimos a resolver, con otra causa.

**Las otras tres métricas:**

| Métrica | Por qué |
| --- | --- |
| Filas pendientes | Tendencia, no valor absoluto |
| Duración del ciclo del publisher | Si sube, el lote es muy grande o Kafka está lento |
| Tasa de duplicados detectados en el consumidor | Confirma que la idempotencia **está trabajando** |

Esa última es la que más tranquilidad da: si es cero, probablemente tu
deduplicación no está conectada.

**El job de reconciliación**, que es la red de última instancia:

```sql
SELECT o.id FROM orders o
LEFT JOIN shipments s ON s.order_id = o.id
WHERE o.estado = 'CONFIRMADA'
  AND o.created_at < now() - interval '30 minutes'
  AND s.id IS NULL;
```

Si esta query devuelve filas, algo se perdió a pesar de todo. Debería dar
siempre cero — y hay que alertar cuando no.

**Cómo lo testeás de verdad:** un test de integración que **mate el proceso
entre el `COMMIT` y el `send`**. Es la única forma de verificar el caso que
este patrón existe para cubrir:

```ts
it('republica el evento si el publisher muere antes de marcarlo', async () => {
  jest.spyOn(producer, 'send').mockImplementationOnce(async () => {
    throw new Error('pod muerto');             // murió después de publicar
  });
  await crearOrden();
  await publisher.publicar().catch(() => {});  // falla
  await publisher.publicar();                  // el siguiente ciclo lo toma
  expect(await eventosEnKafka('order.created')).toHaveLength(1);  // idempotencia del consumidor
});
```

## 7. El costo

Nada de esto es gratis. Lo que estás pagando:

1. **Latencia extra**: el evento sale 20-200 ms después del commit, no en el
   mismo instante. Con `NOTIFY` es casi nada, pero no es cero.
2. **Duplicados garantizados**, y por lo tanto **todos los consumidores tienen
   que ser idempotentes**. Es trabajo real en cada consumidor nuevo, para
   siempre.
3. **Un proceso más que operar**: el publisher necesita deploy, monitoreo,
   alertas y que alguien se acuerde de él.
4. **Una tabla de alta rotación** en tu base, que hay que particionar y
   limpiar. Si te olvidás, en un año tenés 500 millones de filas muertas.
5. **Orden global perdido** si corrés varios publishers con `SKIP LOCKED`. Si
   necesitás orden por agregado, hay que particionar el polling por
   `aggregate_id`.

**Vale la pena** porque la alternativa son 2.920 órdenes al año que
desaparecen sin dejar rastro. Pero decir el costo en voz alta es parte de
entender el patrón — y es lo que separa a alguien que lo copió de alguien que
lo eligió.

---

## Fuentes

- **Chris Richardson**, *Transactional Outbox pattern*:
  <https://microservices.io/patterns/data/transactional-outbox.html>
- **Debezium**, *Reliable Microservices Data Exchange With the Outbox Pattern*
  — la implementación con CDC sobre la tabla outbox:
  <https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/>
- **Postgres**, `SKIP LOCKED`:
  <https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- **Kleppmann**, *DDIA* cap. 11 — por qué 2PC no es la respuesta.

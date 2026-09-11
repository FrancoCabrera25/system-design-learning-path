# Para pensar — Módulo 02, resuelto

Las tres preguntas del final del README, respondidas con código concreto.
Si querés intentarlas vos primero, cerrá este archivo.

---

## 1. `POST /orders`: qué va síncrono, qué va asíncrono, y qué pasa si el cobro sale bien pero el envío falla

### 1.1 La clasificación

Aplicá a cada paso la única pregunta que importa: **"¿qué pasa si esto ocurre
5 minutos más tarde?"**

| Servicio | Si ocurre 5 min tarde... | Decisión |
| --- | --- | --- |
| **A — validar stock** | Le vendiste algo que no existe. **Grave** | **Síncrono** |
| **B — cobrar** | La orden existe sin plata. **Grave** | Síncrono *en la decisión*, asíncrono *en la ejecución* (ver 1.3) |
| **C — reservar envío** | Se reserva 5 min después. Molesto, recuperable | **Asíncrono** |
| **D — mail** | Llega 5 min después. Normal | **Asíncrono** |

El número que respalda la decisión (módulo 01): con los cuatro síncronos, el
techo es `0,999⁴ = 99,60%` → **173 min/mes** de caída. Con sólo A y B duros,
`0,999² = 99,80%` → **86 min/mes**. Sacaste **87 minutos por mes** sin que
nadie mejore un solo servicio.

### 1.2 El matiz que separa una buena respuesta de una excelente

> **Validar no es lo mismo que ejecutar. Sólo la validación necesita estar en
> el camino crítico.**

Envío es el ejemplo perfecto:

- **¿Hay cobertura en ese código postal?** → validación barata, determinística,
  cacheable. **Síncrona.** Si no hay cobertura, la orden no debería existir.
- **Reservar el slot de logística con el transportista** → ejecución, lenta,
  depende de un tercero. **Asíncrona.**

Lo mismo con stock: `¿hay stock?` es síncrono, pero **`reservar` stock también
lo es** — si no reservás en el momento, dos usuarios compran la última unidad.
La reserva se hace con TTL: bloqueás la unidad 15 minutos, y si el pago no
confirma, se libera sola.

### 1.3 El código

```ts
// orders.controller.ts
@Post()
async create(
  @Body() dto: CreateOrderDto,
  @Headers('idempotency-key') idemKey: string,
) {
  if (!idemKey) throw new BadRequestException('Idempotency-Key requerida');

  return this.dataSource.transaction(async (tx) => {
    // 0) Idempotencia: si esta clave ya se usó, devolvemos lo mismo de antes.
    //    El UNIQUE de la tabla es la garantía real, no este SELECT (ver §2.3).
    const previa = await tx.findOne(IdempotencyKey, { where: { key: idemKey } });
    if (previa) return previa.response;

    // 1) SÍNCRONO — validaciones que condicionan si la orden puede existir
    const cobertura = await this.shippingClient.checkCoverage(dto.zipCode); // gRPC, deadline 200ms
    if (!cobertura.available) throw new BadRequestException('Sin cobertura');

    // 2) SÍNCRONO — reservar stock (no descontar: bloquear con TTL)
    const reserva = await this.inventory.reserve(tx, dto.items, { ttlMinutes: 15 });
    if (!reserva.ok) throw new ConflictException('Sin stock');

    // 3) La orden nace en un estado intermedio, no en CONFIRMED
    const order = await tx.save(Order, {
      ...dto,
      status: OrderStatus.PENDING_PAYMENT,
      reservationId: reserva.id,
    });

    // 4) ASÍNCRONO — el evento se escribe en la MISMA transacción (outbox)
    await tx.save(OutboxEvent, {
      aggregateId: order.id,
      topic: 'payment.requested',
      payload: { orderId: order.id, amount: order.total, idemKey },
    });

    const response = { orderId: order.id, status: 'processing' };
    await tx.save(IdempotencyKey, { key: idemKey, response });
    return response; // -> 202 Accepted, en ~60 ms
  });
}
```

Lo importante de ese bloque: **todo lo que tiene que ser atómico está en una
sola transacción de una sola base**. No hay transacción distribuida, no hay
2PC. El evento no se publica: se *escribe*. Un proceso aparte lo publica.

```ts
// outbox.publisher.ts — corre cada 200 ms, o con Debezium leyendo el WAL
@Interval(200)
async publish() {
  const pendientes = await this.repo.find({
    where: { publishedAt: IsNull() },
    order: { createdAt: 'ASC' },
    take: 100,
  });

  for (const ev of pendientes) {
    await this.kafka.emit(ev.topic, ev.payload);        // puede fallar
    await this.repo.update(ev.id, { publishedAt: new Date() });
  }
}
```

> **Por qué esto es at-least-once y no exactly-once:** si el proceso muere
> entre el `emit` y el `update`, el evento se republica. Es inevitable, y por
> eso el consumidor **tiene** que ser idempotente (§2.3). Cambiar el orden no
> ayuda: marcar como publicado antes de publicar convierte "duplicado" en
> "perdido", que es peor.

### 1.4 Qué pasa si el cobro sale bien y la reserva de envío falla

**Ya cobraste. No existe el rollback.** La plata salió de la cuenta del
usuario; ninguna transacción de base de datos puede deshacer eso.

Esto es una **saga**: un flujo largo donde cada paso tiene una compensación,
porque no hay una transacción que abarque tu base, el proveedor de pagos y el
transportista.

```
                    ┌──────────────────┐
                    │ PENDING_PAYMENT  │
                    └────────┬─────────┘
                payment.succeeded   payment.failed
                         │                │
                         ▼                ▼
                 ┌───────────────┐  ┌───────────┐
                 │ PENDING_SHIP  │  │ REJECTED  │──► liberar reserva stock
                 └───────┬───────┘  └───────────┘
            shipment.reserved  │  shipment.failed
                    │          │        │
                    ▼          │        ▼
             ┌───────────┐     │   (1) reintentar con backoff ── vuelve arriba
             │ CONFIRMED │     │   (2) degradar -> PENDING_MANUAL + alerta
             └───────────┘     │   (3) compensar -> REFUNDING -> REFUNDED
                               │       + liberar stock + avisar al usuario
```

**Las tres ramas, en orden de preferencia — y esto es lo que se responde en
una entrevista:**

1. **Reintentar.** La mayoría de los fallos son transitorios (un pico, un
   deploy del transportista, un timeout). Con backoff exponencial + jitter
   durante 30 minutos, la enorme mayoría se resuelve **sin que el usuario se
   entere de nada**. Es la rama correcta el 95% de las veces.
2. **Degradar.** La orden queda `PENDING_MANUAL`: pagada, sin envío
   reservado, visible en un panel de operaciones. Un humano la resuelve. En
   muchísimos negocios reales **ésta es la respuesta correcta**, porque
   cancelar una venta cobrada es peor que resolverla a mano.
3. **Compensar.** Sólo si realmente no hay forma de cumplir: reembolso
   automático, liberación del stock, notificación al usuario.

Y la observación que suma más que las tres juntas:

> **Una compensación no es un rollback.** El usuario ya vio el débito en su
> resumen; el reembolso es un **hecho nuevo**, no la anulación del anterior.
> Diseñar una saga es decidir qué le contás al usuario en cada rama, no sólo
> cómo queda la base de datos.

**Coreografía vs orquestación** (te lo van a preguntar): con 4 pasos como
acá, la **coreografía** (cada servicio escucha eventos y reacciona) alcanza y
es más simple. Cuando la saga tiene 8+ pasos con ramas condicionales, nadie
entiende el flujo completo leyendo 8 repos distintos, y conviene un
**orquestador** explícito (un servicio de sagas, o Temporal / Step Functions)
que tenga el flujo escrito en un solo lugar. La regla: *coreografía hasta que
el flujo deje de caber en tu cabeza.*

---

## 2. Si la notificación es asíncrona, ¿cómo le decís al usuario que la orden se creó? ¿Y si el evento se procesa dos veces?

### 2.1 La confusión que hay que deshacer

"Asíncrono" no significa "el usuario no se entera". Significa que **el trabajo
no vive en la conexión HTTP**. La respuesta al usuario sigue siendo inmediata
— lo que cambia es **qué le prometés**.

```
Síncrono:  "Tu orden está confirmada"        <- prometés el resultado final
Asíncrono: "Recibimos tu orden #A7X2"        <- prometés que no se pierde
```

Esa segunda frase **es verdad en el instante en que commiteó la transacción**.
La orden existe, tiene ID, el stock está reservado y el evento está en la
tabla `outbox`. Nada de eso se puede perder. Podés decírselo con total
honestidad en 60 ms.

### 2.2 Qué ve el usuario, en la línea de tiempo

```
t = 0 ms     clic en "Comprar"            botón deshabilitado + spinner
t = 60 ms    202 { orderId, processing }  "¡Listo! Orden #A7X2 recibida.
                                           Estamos confirmando el pago."
                                          + se abre el canal SSE
t = 1-6 s    payment.succeeded            "Pago confirmado ✅"
t = 8 s      shipment.reserved            "Envío reservado — llega el 14/9"
```

```ts
// El canal de estado. SSE alcanza y es mucho más simple que WebSocket
// cuando la comunicación es en una sola dirección.
@Sse(':id/events')
stream(@Param('id') orderId: string): Observable<MessageEvent> {
  return this.orderEvents.subscribe(orderId); // Redis pub/sub por debajo
}
```

Tres detalles que hacen la diferencia entre que esto se sienta sólido o roto:

- **El estado está persistido, no en la conexión.** Si el usuario cierra el
  navegador y vuelve en una hora, ve la orden en el estado que corresponda.
  Ese es el beneficio real de haberlo desacoplado.
- **Polling como fallback.** SSE se cae detrás de algunos proxies
  corporativos. `GET /orders/:id` cada 2 segundos es feo pero nunca falla.
- **Si a los 30 segundos sigue en `PENDING_PAYMENT`**, decílo: *"Está tardando
  más de lo normal, te avisamos por mail."* El silencio es lo único
  inaceptable.

### 2.3 Si el evento se procesa dos veces

**No es una hipótesis: va a pasar.** Kafka, SQS y el outbox son todos
*at-least-once*. Las causas son cotidianas: un rebalance de consumer group, un
pod que muere después de procesar pero antes de commitear el offset, el
publisher del outbox que republica.

Sin protección, el daño es proporcional al efecto: dos mails (molesto), dos
reservas de envío (costoso), **dos cobros (incidente)**.

**La solución que NO funciona** — y que se escribe todo el tiempo:

```ts
// ❌ ROTO: race condition clásica
const yaProcesado = await this.repo.findOne({ where: { eventId } });
if (yaProcesado) return;
await this.procesar(evento);
await this.repo.save({ eventId });
```

Dos consumers procesando el mismo evento **al mismo tiempo** ejecutan el
`SELECT` antes de que el otro haga el `INSERT`: los dos ven `null`, los dos
procesan. Y esto es *más* probable justo después de un rebalance, que es
exactamente cuando llegan los duplicados. El chequeo y la escritura tienen que
ser **una sola operación atómica**.

**La solución correcta** — el que manda es el índice `UNIQUE` de la base:

```ts
@Entity()
@Unique(['eventId'])          // <-- ESTO es la garantía. El resto es decoración.
export class ProcessedEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() eventId: string;
  @Column({ type: 'jsonb', nullable: true }) result: unknown;
  @CreateDateColumn() processedAt: Date;
}

@EventPattern('payment.succeeded')
async handle(@Payload() ev: PaymentSucceeded) {
  await this.dataSource.transaction(async (tx) => {
    // La marca y el efecto, en la MISMA transacción.
    const insert = await tx
      .createQueryBuilder()
      .insert()
      .into(ProcessedEvent)
      .values({ eventId: ev.eventId })
      .orIgnore()                 // ON CONFLICT DO NOTHING
      .execute();

    if (insert.identifiers.length === 0) {
      this.logger.log(`Evento ${ev.eventId} ya procesado, descarto`);
      return;                     // duplicado: salimos sin hacer nada
    }

    await tx.update(Order, ev.orderId, { status: OrderStatus.PENDING_SHIPMENT });
    await tx.save(OutboxEvent, { topic: 'shipment.requested', payload: { ... } });
  });
}
```

Por qué esto sí funciona: si dos consumers corren a la vez, **uno de los dos
`INSERT` falla por el `UNIQUE`** — la base serializa el acceso, no tu código.
Y como el efecto está en la misma transacción, o quedan la marca y el efecto,
o no queda ninguno. Nunca "marcado pero no hecho".

### 2.4 El caso difícil: efectos que no viven en tu base

Todo lo anterior funciona porque marca y efecto comparten transacción. **¿Y si
el efecto es llamar a una API externa?** Ahí no hay transacción posible y
volvés al problema original.

```ts
// El efecto externo lleva SU PROPIA clave de idempotencia, derivada de forma
// determinística. El proveedor deduplica del otro lado.
await this.stripe.charges.create(
  { amount, currency: 'ars', customer },
  { idempotencyKey: `order-${orderId}-charge` },  // <-- misma clave siempre
);
```

**La clave tiene que ser determinística**, derivada del evento — no un
`uuid()` nuevo en cada intento, que es el error más común y anula toda la
protección. Si el reintento genera una clave distinta, para Stripe son dos
cobros diferentes.

Cuando el proveedor **no** soporta idempotencia (pasa seguido con APIs
viejas), el patrón es registrar la intención antes de ejecutar:

```
1. INSERT intento (estado=PENDING, eventId único)   <- commit
2. llamar a la API externa
3. UPDATE intento (estado=DONE, respuesta)          <- commit
```

Si el proceso muere entre 1 y 3, al reintentar encontrás el `PENDING` y sabés
que **puede** haberse ejecutado: ahí consultás al proveedor (`GET /charges?
reference=...`) antes de reintentar a ciegas. No es elegante, pero es lo que
hay, y saber explicarlo vale mucho en una entrevista.

Regla general para cerrar:

> **Idempotente ≠ "no hace nada la segunda vez". Idempotente = "el estado
> final del sistema es el mismo, se ejecute una o cien veces".**

`UPDATE saldo SET monto = 100` es idempotente. `UPDATE saldo SET monto =
monto + 50` no lo es, aunque las dos sean un `UPDATE`.

---

## 3. Evolución del contrato: agregar, renombrar, y cambiar `int32` a `int64`

### 3.1 El punto de partida

```protobuf
message OrderCreated {
  string id       = 1;
  int32  amount   = 2;   // centavos
  string currency = 3;
}
```

Todo depende de un solo hecho: **los nombres de los campos no viajan por el
cable. Viajan los NÚMEROS.** Cada campo se serializa como
`tag = (número << 3) | wire_type`, seguido del valor. La palabra `"amount"`
no aparece en ningún byte del mensaje.

De ahí salen las tres respuestas, sin necesidad de memorizar nada.

### 3.2 Las tres preguntas

**(a) Agregás un campo nuevo → ✅ no se rompe nada.**

```protobuf
string coupon_code = 4;   // número NUEVO
```

El consumidor viejo recibe un campo 4 que no conoce y **lo ignora** (protobuf
lo preserva en "unknown fields" y lo reenvía si reserializa). El consumidor
nuevo, leyendo mensajes viejos, ve el campo vacío. Funciona en las dos
direcciones, que es exactamente lo que necesitás durante un rolling update
donde conviven las dos versiones.

Corolario práctico: **el campo nuevo tiene que ser opcional en la semántica de
tu negocio.** Si tu código nuevo hace `if (!ev.couponCode) throw`, rompiste
igual — no por protobuf, sino por tu propia lógica.

**(b) Renombrás `amount` → `amount_cents` (mismo número) → ✅ en el cable,
⚠️ en el código.**

Los bytes son **idénticos**. Cero riesgo en runtime.

Pero **rompe la compilación** de todo el que regenere los stubs:
`getAmount()` pasa a ser `getAmountCents()`. No es un incidente de producción,
es un bump coordinado de la librería de stubs.

⚠️ **Una excepción que muerde:** si en algún punto del pipeline serializás a
JSON (gRPC-Gateway, `protobuf.util.toJSON`, un topic de Kafka en JSON), **ahí
el nombre sí viaja** y el renombrado se vuelve un cambio incompatible. Fijate
qué hace tu stack antes de dar por gratis un renombrado.

**(c) `int32 amount = 2` → `int64 amount = 2` → ✅ seguro, y es la excepción
que hay que conocer.**

`int32`, `int64`, `uint32`, `uint64`, `bool` y `enum` comparten el mismo
**wire type 0 (varint)** y son **compatibles entre sí**. Los bytes de un
número chico son exactamente los mismos en los dos tipos.

El único riesgo es el **truncamiento**: si empezás a mandar valores que no
entran en 32 bits, un consumidor viejo los va a leer truncados y mal —
silenciosamente. Mientras los valores reales quepan en `int32`, no pasa nada.

**NO** son compatibles: `int32 ↔ string`, `int32 ↔ bytes`, `int32 ↔ sint32`
(usa codificación zigzag), `int32 ↔ fixed32` (wire type 5, no 0).

### 3.3 Lo que SÍ rompe todo, y que nadie pregunta porque no se le ocurre

```protobuf
// ❌ CATÁSTROFE SILENCIOSA
message OrderCreated {
  string id      = 1;
  int32  amount  = 2;
  string country = 3;   // <- antes acá vivía 'currency'
}
```

Durante el rolling update, un consumidor **nuevo** recibe un mensaje de un
productor **viejo** con el campo 3 = `"ARS"` y lo lee como `country = "ARS"`.
**Sin ningún error**: los dos son strings, el wire type coincide, el parseo
funciona perfecto. Los datos se corrompen en silencio y el bug aparece
semanas después, en un reporte que no cierra.

Lo correcto:

```protobuf
reserved 3;
reserved "currency";
string country = 4;
```

`reserved` existe exactamente para que el compilador frene esto dentro de dos
años, cuando ninguno de los dos siga en el equipo.

### 3.4 La regla que engloba todo: *expand / migrate / contract*

> **Nunca hagas un cambio incompatible en un solo deploy.**

| Fase | Qué hacés | Estado del sistema |
| --- | --- | --- |
| **Expand** | Agregás `amount_cents = 4`. El productor escribe **los dos** campos | Viejos y nuevos funcionan |
| **Migrate** | Todos los consumidores pasan a leer el campo 4. Deploy completo | Nadie lee el campo 2 |
| **Contract** | El productor deja de escribir el 2. `reserved 2;` | Limpio |

Entre fase y fase pasan días o semanas, no minutos. El costo es tener dos
campos conviviendo un tiempo; el beneficio es que **ningún deploy puede
romper producción**, porque en ningún momento hay una versión que dependa de
algo que la otra no tenga.

Es el mismo patrón que se usa para migraciones de esquema sin downtime
(módulo 05) y para cambiar una API pública (módulo 13). Vale la pena
internalizarlo ahora: reaparece tres veces más en este path.

### 3.5 Probalo

```bash
node modules/02-comunicacion-servicios/evolucion-contrato.ts
```

Ese script serializa un mensaje con el schema viejo, lo decodifica con cuatro
schemas nuevos distintos, y te muestra cuál sobrevive y cuál corrompe los
datos **sin lanzar ni un error**. Ver la corrupción silenciosa en tu propia
terminal es bastante más convincente que leerla.

# ¿Cuándo uso outbox? (y por qué no reemplaza a la saga)

Dos preguntas que se mezclan todo el tiempo:

1. *"¿Cuándo publico directo a Kafka/SQS y cuándo paso por la base?"*
2. *"Si uso outbox, ¿entonces ya no hay saga?"*

La segunda tiene respuesta corta: **la saga sigue estando, y usa el outbox
adentro.** Son dos capas distintas. Pero vamos por partes.

---

## 1. La regla de una sola pregunta

Olvidate de Kafka, de SQS y del outbox por un segundo. La única pregunta es:

> ### En esta unidad de trabajo, ¿cambio MI estado **y además** tengo que avisarle a alguien?

| ¿Cambio mi estado? | ¿Tengo que avisar? | Qué necesitás |
| --- | --- | --- |
| ❌ No | ✅ Sí | **Publicá directo.** No hay outbox: no hay doble escritura |
| ✅ Sí | ❌ No | **Transacción normal.** No hay outbox: no hay evento |
| ✅ **Sí** | ✅ **Sí** | 🔴 **OUTBOX.** Son dos escrituras en dos sistemas sin transacción común |

Eso es todo. El outbox **no** es "la forma correcta de publicar eventos": es
la forma de que **dos escrituras que no pueden ser atómicas se comporten como
si lo fueran**. Si no tenés dos escrituras, no tenés el problema, y meter un
outbox es complejidad gratis.

### Los seis casos concretos

```
┌─ CASO 1 ──────────────────────────────────────────────────────────┐
│  POST /orders  ->  guarda la orden  +  avisa "order.created"       │
│                                                                    │
│  ¿Cambio mi estado?  SÍ (INSERT en orders)                        │
│  ¿Aviso?             SÍ (order.created)                           │
│                                              ──►  🔴 OUTBOX        │
└────────────────────────────────────────────────────────────────────┘

┌─ CASO 2 ──────────────────────────────────────────────────────────┐
│  Un gateway recibe un webhook de Stripe y lo reenvía a Kafka.      │
│  No guarda nada: sólo traduce y reenvía.                           │
│                                                                    │
│  ¿Cambio mi estado?  NO                                            │
│  ¿Aviso?             SÍ                                            │
│                                     ──►  ✅ PUBLICÁ DIRECTO        │
│                                                                    │
│  Si el publish falla, devolvés error y Stripe reintenta. No hay    │
│  nada tuyo que pueda quedar inconsistente, porque no guardaste     │
│  nada. (Si además querés guardar el webhook crudo para auditoría,  │
│  volvés al caso 1.)                                                │
└────────────────────────────────────────────────────────────────────┘

┌─ CASO 3 ──────────────────────────────────────────────────────────┐
│  PATCH /users/:id/nombre  ->  actualiza el nombre. Nadie más       │
│  necesita enterarse.                                               │
│                                                                    │
│  ¿Cambio mi estado?  SÍ                                            │
│  ¿Aviso?             NO                                            │
│                                     ──►  ✅ TRANSACCIÓN NORMAL     │
│                                                                    │
│  Y esto es más común de lo que parece: no todo cambio de estado    │
│  es un evento de dominio. Publicar eventos "por las dudas" llena   │
│  Kafka de ruido que nadie consume y que igual hay que mantener.    │
└────────────────────────────────────────────────────────────────────┘

┌─ CASO 4 ──────────────────────────────────────────────────────────┐
│  POST /eventos de analytics: 50.000/s, no se valida nada contra    │
│  estado, no hay nada que rechazar.                                 │
│                                                                    │
│  ¿Cambio mi estado?  NO (el log ES el destino)                     │
│                                     ──►  ✅ PUBLICÁ DIRECTO        │
│                                          (el "log primero" de      │
│                                           outbox-brokers.md §2)    │
└────────────────────────────────────────────────────────────────────┘

┌─ CASO 5 ──────────────────────────────────────────────────────────┐
│  Un consumer lee "payment.succeeded", marca la orden como pagada,  │
│  y emite "shipment.requested".                                     │
│                                                                    │
│  ¿Cambio mi estado?  SÍ (orders.status = PAID)                     │
│  ¿Aviso?             SÍ (shipment.requested)                       │
│                                              ──►  🔴 OUTBOX        │
│                                                                    │
│  Que el disparador sea un evento de Kafka en vez de un HTTP no     │
│  cambia NADA. El disparador es irrelevante: lo que manda es qué    │
│  escribís.                                                         │
└────────────────────────────────────────────────────────────────────┘

┌─ CASO 6 ──────────────────────────────────────────────────────────┐
│  Un cron nocturno recalcula métricas y emite "metrics.updated".    │
│                                                                    │
│  ¿Cambio mi estado?  SÍ                                            │
│  ¿Aviso?             SÍ                                            │
│                                              ──►  🔴 OUTBOX        │
│                                                                    │
│  ...salvo que la pérdida de ese evento sea trivial porque el       │
│  cron vuelve a correr mañana y lo arregla solo. Ahí publicar       │
│  directo es una decisión legítima: el sistema se auto-repara.      │
│  PERO DECIDILO, no lo heredes por descuido.                        │
└────────────────────────────────────────────────────────────────────┘
```

**Fijate el caso 5**, que es exactamente lo que preguntabas: *"llega el evento
de crear orden... ¿en vez de ir directo a Kafka, primero guardamos y después
emitimos?"*. **Sí, exactamente eso.** Y el hecho de que el disparador haya
sido un evento no cambia la decisión: lo único que importa es que en esa
unidad de trabajo estás escribiendo en **tu base** y en **el broker**.

### El contraejemplo que aclara todo

Si tu handler es esto:

```ts
@EventPattern('order.created')
async handle(ev: OrderCreated) {
  await this.mailer.send(ev.email, 'Gracias por tu compra');   // efecto externo
  // no guarda NADA en su base
}
```

**No necesitás outbox.** No hay dos escrituras: hay una sola (el mail). Lo que
sí necesitás es idempotencia, porque el evento puede llegar dos veces y el
mail se mandaría dos veces.

Pero apenas agregás una línea:

```ts
  await this.repo.save(NotificacionEnviada, { orderId: ev.orderId });  // ahora sí
```

...ya tenés dos escrituras (la base y el proveedor de mail) y volvés al mismo
problema. *(Con un agravante: el proveedor de mail no tiene outbox posible,
porque no controlás su lado. Ahí el patrón es "registrar la intención antes de
ejecutar", como en `para-pensar.md` §2.4.)*

---

## 2. Outbox y saga son capas distintas

Acá está la otra mitad de tu pregunta. **No** son alternativas.

| | **OUTBOX** | **SAGA** |
| --- | --- | --- |
| Qué resuelve | Que **un** mensaje no se pierda ni se invente | Que **un flujo de N pasos** termine bien o se deshaga |
| Alcance | Una sola transacción, un solo servicio | Varios servicios, minutos u horas |
| Pregunta que responde | *"¿Cómo garantizo que el evento salga si guardé el dato?"* | *"¿Qué hago si el paso 3 falla después de que el paso 2 ya cobró?"* |
| Nivel | **Mecanismo de entrega** | **Coordinación de negocio** |
| Analogía | Que la carta no se pierda en el correo | El itinerario del viaje |

Y la relación entre las dos:

> **La saga define QUÉ pasos hay y cómo se compensan.
> El outbox garantiza que CADA MENSAJE entre pasos llegue.
> La saga USA el outbox en cada paso.**

### Cómo se ven juntos

Tomemos la saga de `POST /orders` con 4 pasos coreografiados. Cada caja es un
servicio distinto, con su propia base:

```
┌─ SERVICIO ÓRDENES ────────────────────────────────────────────────┐
│  BEGIN                                                             │
│    INSERT orders (estado = PENDING_PAYMENT)      <- su estado      │
│    INSERT outbox ('payment.requested')           <- el evento      │
│  COMMIT                                          ← 🔴 OUTBOX #1    │
└────────────────────────────────┬───────────────────────────────────┘
                                 ▼  Kafka
┌─ SERVICIO PAGOS ──────────────────────────────────────────────────┐
│  consume 'payment.requested'  (idempotente: dedup por eventId)     │
│  llama al proveedor con Idempotency-Key                            │
│  BEGIN                                                             │
│    INSERT payments (estado = SUCCEEDED)          <- su estado      │
│    INSERT outbox ('payment.succeeded')           <- el evento      │
│  COMMIT                                          ← 🔴 OUTBOX #2    │
└────────────────────────────────┬───────────────────────────────────┘
                                 ▼  Kafka
┌─ SERVICIO LOGÍSTICA ──────────────────────────────────────────────┐
│  consume 'payment.succeeded'                                       │
│  BEGIN                                                             │
│    INSERT shipments (estado = RESERVED)                            │
│    INSERT outbox ('shipment.reserved')           ← 🔴 OUTBOX #3    │
│  COMMIT                                                            │
└────────────────────────────────┬───────────────────────────────────┘
                                 ▼  Kafka
┌─ SERVICIO ÓRDENES ────────────────────────────────────────────────┐
│  consume 'shipment.reserved'                                       │
│  UPDATE orders SET estado = 'CONFIRMED'                            │
│  (no emite nada más -> acá NO hace falta outbox)                   │
└────────────────────────────────────────────────────────────────────┘

   ═══ LA SAGA es este flujo completo, con sus estados y sus ramas ═══
   ═══ EL OUTBOX es cada uno de los tres 🔴 ═══
```

**Tres outbox distintos, en tres servicios distintos, en una sola saga.** Y
el último paso no necesita outbox porque no emite nada — que es la regla de
la sección 1 aplicada paso por paso.

### La rama de compensación también usa outbox

```
┌─ SERVICIO LOGÍSTICA ── no hay cobertura, falla ───────────────────┐
│  BEGIN                                                             │
│    INSERT shipments (estado = FAILED)                              │
│    INSERT outbox ('shipment.failed')             ← 🔴 OUTBOX       │
│  COMMIT                                                            │
└────────────────────────────────┬───────────────────────────────────┘
                                 ▼
┌─ SERVICIO PAGOS ── compensa ──────────────────────────────────────┐
│  consume 'shipment.failed'                                         │
│  reembolsa (con Idempotency-Key)                                   │
│  BEGIN                                                             │
│    UPDATE payments SET estado = 'REFUNDED'                         │
│    INSERT outbox ('payment.refunded')            ← 🔴 OUTBOX       │
│  COMMIT                                                            │
└────────────────────────────────────────────────────────────────────┘
```

La compensación es un paso más de la saga. Y como también cambia estado y
también avisa, también lleva outbox.

### Por qué una saga SIN outbox no funciona

Éste es el punto que cierra la relación entre los dos, y vale la pena que
quede grabado:

> **Una saga asume que los mensajes entre pasos llegan. El outbox es lo que
> hace que esa suposición sea cierta.**

Sin outbox, en el servicio de pagos:

```
COMMIT del pago  ✅  (el cliente ya fue cobrado)
💥 el pod muere
emit('payment.succeeded')  ❌  nunca salió
```

La orden queda en `PENDING_PAYMENT` **para siempre**. El cliente pagó, el
envío nunca se reserva, y **nadie ve ningún error**: la saga no falló, se
**colgó**. Es el peor estado posible de un flujo de negocio, porque no dispara
ninguna alerta ni ninguna compensación — simplemente deja de avanzar.

Con outbox, el evento está en la tabla y sale cuando el proceso vuelva. La
saga se demora, no se cuelga.

*(Por eso, además, toda saga necesita un **timeout por paso**: si `payment`
no responde en 10 minutos, se dispara la compensación. El outbox evita la
pérdida del mensaje; el timeout cubre el caso en que el otro servicio
directamente no puede. Son dos defensas para dos fallas distintas.)*

---

## 3. ¿Y si no hay varios pasos? Entonces no hay saga

La saga aparece cuando hay **varios pasos en varios servicios con
compensación**. Si no, sobra:

| Situación | ¿Saga? | ¿Outbox? |
| --- | --- | --- |
| Guardo la orden y le mando un mail al usuario | ❌ No hay pasos que deshacer: si el mail falla, se reintenta | ✅ Sí |
| Guardo la orden, cobro, reservo envío, y si el envío falla hay que reembolsar | ✅ **Sí** | ✅ Sí, en cada paso |
| Guardo la orden y actualizo el índice de búsqueda | ❌ Si el índice falla, se reintenta y listo | ✅ Sí |
| Guardo el nombre del usuario | ❌ | ❌ |

**La señal de que necesitás saga: un paso posterior puede fallar cuando un
paso anterior YA produjo un efecto que no se puede deshacer solo** (cobrar,
mandar un mail, reservar inventario, llamar a un tercero).

Si todos los pasos posteriores son simplemente *reintentables* —indexar,
notificar, actualizar analytics— no hay saga: hay eventos con reintentos y
DLQ. La mayoría de los flujos son de éstos, y llamarlos "saga" es
sobre-ingeniería con nombre elegante.

---

## 4. El resumen que te podés llevar

```
             ¿Cambio mi estado Y aviso a alguien?
                          │
             ┌────────────┴─────────────┐
            NO                         SÍ
             │                          │
    Publicá directo /             🔴 OUTBOX
    transacción normal                  │
                          ¿Hay pasos posteriores que,
                          al fallar, obligan a DESHACER
                          un efecto ya producido?
                                        │
                          ┌─────────────┴────────────┐
                         NO                         SÍ
                          │                          │
                 Eventos + reintentos          🟣 SAGA
                 + DLQ. No es saga.        (con outbox en
                                            cada uno de sus
                                            pasos, y timeouts)
```

Y las tres frases para una entrevista:

1. **"El outbox no es la forma correcta de publicar eventos: es la forma de
   resolver la doble escritura. Si sólo publico y no guardo nada mío, publico
   directo."**
2. **"La saga define el flujo y sus compensaciones; el outbox garantiza que
   cada mensaje del flujo llegue. La saga usa outbox adentro, en cada paso que
   cambia estado y emite."**
3. **"Una saga sin outbox no falla: se cuelga. Y un flujo colgado es peor que
   uno que falla, porque no dispara ninguna alerta."**

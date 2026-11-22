# Caso 03 — El pago que salió bien y el envío que falló

> **Módulos:** 09 (patrones de datos distribuidos, *adelantado*) ·
> [02 (comunicación)](../modules/02-comunicacion-servicios/) ·
> [06 (idempotencia)](../modules/06-idempotencia/)
> **Patrón:** Saga con compensaciones (coreografía)

---

## 1. El escenario

`POST /orders` tiene que coordinar cuatro servicios, cada uno con **su propia
base de datos**:

```
órdenes     inventario     pagos (proveedor externo)     logística
   │             │                   │                       │
   └── reservar stock ── cobrar ── reservar envío ── confirmar
```

```
8.000 órdenes por día · ticket promedio USD 120
cobro:   p99 4 s, SLA del proveedor 99,5%
envío:   el transportista tiene 99,8% y una API que a veces devuelve 503
```

El 0,3% de las órdenes llega al paso de envío y **falla ahí**: el código
postal quedó fuera de cobertura, el transportista está caído, o el slot que
había se tomó hace 40 segundos. Son **24 órdenes por día**.

## 2. Qué se rompe

**Ya cobraste.** La plata salió de la cuenta del cliente. Y acá está el hecho
del que sale todo este caso:

> **No existe el rollback.** Ninguna transacción de base de datos puede
> deshacer un cobro en un proveedor externo. No hay `ROLLBACK` que alcance a
> Stripe.

Y hay dos formas de que esto se rompa. La segunda es la grave.

**Forma 1 — falla y lo sabés.** El `POST /orders` devuelve 500. El cliente ve
un error. Pero **el cobro ocurrió**: el usuario tiene un débito en su resumen
y ninguna orden. Entra por soporte, nadie encuentra la orden porque nunca se
confirmó, y la plata está en el limbo contable.

**Forma 2 — la que de verdad duele: la saga se cuelga.**

```
COMMIT del pago (estado = PAGADA)   ✅   el cliente ya fue cobrado
💥 el pod muere
emit('shipment.requested')          ❌   nunca salió
```

La orden queda en `PAGADA` **para siempre**. Y fijate lo que pasa:

- No hay error en ningún log. El pago fue exitoso.
- No se dispara ninguna compensación, porque **nada falló**.
- No hay alerta, porque nadie está mirando "órdenes que llevan mucho tiempo en
  un estado intermedio".
- El cliente pagó, no recibe nada, y el sistema **cree que está todo bien**.

> **Una saga no falla: se cuelga.** Y un flujo colgado es peor que uno que
> falla, porque un fallo dispara algo y un cuelgue no dispara nada.

De ahí sale la primera conclusión, que no es sobre sagas:

> **Una saga asume que los mensajes entre pasos llegan. El outbox
> ([caso 01](01-outbox-el-evento-que-nunca-salio.md)) es lo que hace que esa
> suposición sea cierta.** Sin outbox, no tenés una saga: tenés una secuencia
> de pasos que se interrumpe en silencio.

## 3. La solución probada

Una **saga**: un flujo de larga duración partido en pasos locales, donde cada
paso tiene **una acción** y **una compensación**, y el estado del flujo está
**persistido** en una máquina de estados.

El patrón lo formalizó Garcia-Molina en 1987 (*Sagas*, SIGMOD), lo documenta
Chris Richardson en `microservices.io`, y es lo que implementan por debajo
Temporal, AWS Step Functions y Camunda.

**Lo que hay que entender antes de escribir código:**

> **Una compensación NO es un rollback.** El usuario ya vio el débito en su
> resumen; el reembolso es un **hecho nuevo**, no la anulación del anterior.
> Diseñar una saga es decidir **qué le contás al usuario en cada rama**, no
> sólo cómo queda la base de datos.

Y las tres ramas posibles cuando un paso falla, **en orden de preferencia**:

| | Rama | Cuándo | Qué ve el usuario |
| --- | --- | --- | --- |
| 1 | **Reintentar** | La mayoría de los fallos son transitorios | **Nada**: se resuelve solo |
| 2 | **Degradar** | Se puede cumplir, con intervención | "Tu orden está confirmada, te avisamos el envío" |
| 3 | **Compensar** | No hay forma de cumplir | "No pudimos completar tu orden, te reembolsamos" |

**El 95% de los casos es la rama 1**, y es la que casi nadie implementa bien.
La rama 3 es la que todos los diagramas de sagas dibujan y la que menos se
usa.

## 4. La implementación

### 4.1 La máquina de estados — el corazón de la saga

```sql
CREATE TYPE estado_orden AS ENUM (
  'PENDIENTE_PAGO',      -- stock reservado, esperando el cobro
  'PAGADA',              -- cobrada, esperando el envío
  'PENDIENTE_MANUAL',    -- cobrada, el envío falló, lo resuelve un humano
  'CONFIRMADA',           -- terminada bien
  'RECHAZADA',            -- el cobro falló: no se cobró nada
  'REEMBOLSANDO',         -- compensando
  'REEMBOLSADA'           -- compensada
);

CREATE TABLE orders (
  id             uuid PRIMARY KEY,
  estado         estado_orden NOT NULL,
  reserva_id     uuid,                      -- para compensar el stock
  cobro_id       text,                       -- para compensar el pago
  envio_id       text,
  intentos_envio int NOT NULL DEFAULT 0,
  estado_desde   timestamptz NOT NULL DEFAULT now(),   -- ← para detectar cuelgues
  version        int NOT NULL DEFAULT 0
);

-- La query que detecta sagas colgadas (§6)
CREATE INDEX idx_orders_estado_desde ON orders (estado, estado_desde)
  WHERE estado IN ('PENDIENTE_PAGO', 'PAGADA', 'REEMBOLSANDO');
```

`estado_desde` es la columna que convierte "se colgó en silencio" en una
alerta. Es una columna y es la diferencia entre enterarte en 5 minutos o por
un cliente en 3 días.

### 4.2 El inicio — síncrono sólo lo que puede rechazar

```ts
@Post()
async create(@Body() dto: CreateOrderDto, @Headers('idempotency-key') key: string) {
  // SÍNCRONO: validaciones que pueden RECHAZAR la orden.
  // Validar no es lo mismo que ejecutar: sólo la validación va en el camino crítico.
  const cobertura = await this.logistica.verificarCobertura(dto.zipCode);   // 150 ms
  if (!cobertura.disponible) throw new BadRequestException('Sin cobertura');

  return this.dataSource.transaction(async (tx) => {
    // Reservar stock (no descontar): bloqueo con TTL
    const reserva = await this.inventario.reservar(tx, dto.items, { ttlMin: 20 });
    if (!reserva.ok) throw new ConflictException('Sin stock');

    const orden = await tx.save(Order, {
      id: ulid(), estado: 'PENDIENTE_PAGO', reservaId: reserva.id, ...dto,
    });

    // El primer paso de la saga sale por OUTBOX, en la misma transacción
    await tx.save(OutboxEvent, {
      aggregateId: orden.id,
      topic: 'payment.requested',
      payload: { ordenId: orden.id, monto: orden.total, idemKey: `orden-${orden.id}-cobro` },
    });

    return { ordenId: orden.id, estado: 'procesando' };   // 202, en ~250 ms
  });
}
```

### 4.3 Cada paso: consumir idempotente → actuar → emitir por outbox

```ts
@EventPattern('payment.succeeded')
async onPagoExitoso(@Payload() ev: PaymentSucceeded, @Ctx() ctx: KafkaContext) {
  const eventId = ctx.getMessage().headers.eventId.toString();

  await this.dataSource.transaction(async (tx) => {
    // 1. Deduplicación: el UNIQUE serializa, no el if (caso 02)
    const ins = await tx.createQueryBuilder().insert().into(ProcessedEvent)
      .values({ eventId }).orIgnore().execute();
    if (ins.identifiers.length === 0) return;

    // 2. Transición ATÓMICA de estado: la segunda vez afecta 0 filas
    const upd = await tx.createQueryBuilder().update(Order)
      .set({ estado: 'PAGADA', cobroId: ev.cobroId, estadoDesde: () => 'now()' })
      .where('id = :id AND estado = :esperado', { id: ev.ordenId, esperado: 'PENDIENTE_PAGO' })
      .execute();
    if (upd.affected === 0) return;        // ya no estaba en PENDIENTE_PAGO: nada que hacer

    // 3. El paso siguiente, por outbox, en la MISMA transacción
    await tx.save(OutboxEvent, {
      aggregateId: ev.ordenId,
      topic: 'shipment.requested',
      payload: { ordenId: ev.ordenId, idemKey: `orden-${ev.ordenId}-envio` },
    });
  });
}
```

Esas tres piezas —**dedup por `UNIQUE`**, **transición condicionada por el
estado esperado**, y **el evento siguiente en la misma transacción**— son el
esqueleto de **todos** los pasos de la saga. El `WHERE estado = :esperado` es
idempotencia gratis: si el evento llega dos veces, el segundo `UPDATE` afecta
cero filas.

### 4.4 La rama 1 — reintentar, que es el 95% de los casos

```ts
@EventPattern('shipment.failed')
async onEnvioFallido(@Payload() ev: ShipmentFailed) {
  const orden = await this.repo.findOneBy({ id: ev.ordenId });

  // ¿Es transitorio? Entonces reintentamos, con backoff y jitter (módulo 08)
  if (ev.motivo === 'PROVEEDOR_CAIDO' && orden.intentosEnvio < 8) {
    await this.dataSource.transaction(async (tx) => {
      await tx.increment(Order, { id: orden.id }, 'intentosEnvio', 1);
      await tx.save(OutboxEvent, {
        aggregateId: orden.id,
        topic: 'shipment.requested',
        disponibleEn: new Date(Date.now() + backoffConJitter(orden.intentosEnvio)),
        payload: { ordenId: orden.id, idemKey: `orden-${orden.id}-envio` },
      });
    });
    return;                                 // el usuario no se enteró de nada
  }

  // Permanente o agotamos los reintentos -> rama 2 o 3
  await this.decidirRamaFinal(orden, ev);
}
```

### 4.5 Las ramas 2 y 3 — degradar o compensar

```ts
private async decidirRamaFinal(orden: Order, ev: ShipmentFailed) {
  // RAMA 2 — DEGRADAR. En muchísimos negocios ésta es la respuesta correcta:
  // cancelar una venta ya cobrada es peor que resolverla a mano.
  if (ev.motivo === 'SIN_SLOT' || ev.motivo === 'PROVEEDOR_CAIDO') {
    await this.dataSource.transaction(async (tx) => {
      await tx.update(Order, { id: orden.id },
        { estado: 'PENDIENTE_MANUAL', estadoDesde: () => 'now()' });
      await tx.save(OutboxEvent, {
        aggregateId: orden.id, topic: 'ops.revision_requerida',
        payload: { ordenId: orden.id, motivo: ev.motivo },
      });
    });
    return;
  }

  // RAMA 3 — COMPENSAR. Sólo cuando no hay forma de cumplir.
  await this.dataSource.transaction(async (tx) => {
    await tx.update(Order, { id: orden.id },
      { estado: 'REEMBOLSANDO', estadoDesde: () => 'now()' });

    // Las compensaciones también salen por outbox: cada una es un paso más
    await tx.save(OutboxEvent, {
      aggregateId: orden.id, topic: 'payment.refund_requested',
      payload: { ordenId: orden.id, cobroId: orden.cobroId,
                 idemKey: `orden-${orden.id}-reembolso` },      // ← determinística
    });
    await tx.save(OutboxEvent, {
      aggregateId: orden.id, topic: 'inventory.release_requested',
      payload: { reservaId: orden.reservaId },
    });
    await tx.save(OutboxEvent, {
      aggregateId: orden.id, topic: 'notification.requested',
      payload: { ordenId: orden.id, template: 'orden-no-completada' },
    });
  });
}
```

**Las compensaciones son pasos de la saga como cualquier otro**: idempotentes,
con su propia clave, por outbox, y con su propio reintento. Una compensación
que falla y nadie reintenta es peor que no haberla intentado.

### 4.6 El barredor de sagas colgadas — la pieza que nadie implementa

El outbox evita que el mensaje **se pierda**. Esto cubre el caso en que el
otro servicio **simplemente no puede**: está caído, su consumidor está roto,
o alguien borró el topic.

```ts
@Cron('*/2 * * * *')          // en un CronJob de k8s, no en los N pods (módulo 03)
async barrerSagasColgadas() {
  const limites: Record<string, number> = {
    PENDIENTE_PAGO: 10 * 60_000,
    PAGADA:          5 * 60_000,
    REEMBOLSANDO:   30 * 60_000,
  };

  for (const [estado, limiteMs] of Object.entries(limites)) {
    const colgadas = await this.repo.find({
      where: { estado, estadoDesde: LessThan(new Date(Date.now() - limiteMs)) },
      take: 100,
    });

    for (const orden of colgadas) {
      this.logger.warn(`Saga colgada: ${orden.id} en ${estado} desde ${orden.estadoDesde}`);
      await this.metricas.increment('saga.colgada', { estado });
      await this.reemitirPasoPendiente(orden);     // idempotente: no duplica nada
    }
  }
}
```

**Sin esto, un bug en el consumidor de envíos deja órdenes pagadas colgadas
indefinidamente y nadie se entera.** Es la diferencia entre un sistema que se
auto-repara y uno que depende de que un cliente se queje.

## 5. Por qué así y no de otra forma

### ❌ "Metelo todo en una transacción distribuida (2PC)"

Es lo primero que se le ocurre a cualquiera, y por eso conviene saber por qué
se descarta:

- **El proveedor de pagos no participa.** Stripe no tiene una API de "preparate
  para commitear". Ningún tercero la tiene. El 2PC requiere que **todos** los
  participantes lo implementen.
- Es **bloqueante**: los locks se retienen hasta que el coordinador decide. Con
  un cobro de 4 segundos, estás bloqueando filas de inventario 4 segundos.
- El **coordinador es un SPOF**, y si se cae en la fase de commit los
  participantes quedan indeterminados.

**No es que 2PC sea malo en teoría: es que no se puede aplicar.** Y esa es la
razón de existir de las sagas.

### ❌ "Reintentá el envío para siempre"

La rama 1 es correcta **y necesita un límite**. Sin límite:

- Una orden con un código postal que **nunca** va a tener cobertura reintenta
  eternamente, consumiendo trabajo y llenando logs.
- El stock queda reservado para siempre, así que **le estás negando esa unidad
  a clientes que sí podés atender**.
- El usuario no recibe nada ni se le reembolsa: el peor de los mundos.

Reintentar es la rama correcta **para fallos transitorios**, y la clasificación
del error es parte del diseño, no un detalle. Es la misma clasificación del
[módulo 08](../modules/08-fiabilidad/): transitorio vs permanente.

### ❌ "Si el envío falla, revertimos todo"

Suena limpio y es **el error conceptual del tema**: **no hay nada que
revertir**. El cobro ocurrió. Lo único que podés hacer es un **hecho nuevo**
(un reembolso) que, desde el punto de vista del usuario, no es lo mismo:

- Vio un débito y después un crédito en su resumen.
- Según el medio de pago, el reembolso tarda entre 2 y 15 días hábiles.
- Si era una tarjeta de crédito, le ocupó el límite mientras tanto.

Y por eso la rama 2 (degradar) suele ser **mejor para el negocio** que la 3
(compensar): resolver a mano una orden cobrada es más barato que un reembolso,
un cliente molesto y un ticket de soporte.

### ❌ Orquestación cuando alcanza la coreografía (y al revés)

| | **Coreografía** (lo de este caso) | **Orquestación** |
| --- | --- | --- |
| Cómo | Cada servicio escucha eventos y reacciona | Un orquestador manda comandos y lleva el estado |
| Acoplamiento | Bajo: nadie conoce a los demás | El orquestador conoce a todos |
| ¿Dónde está el flujo? | **Repartido en N repos** | **En un solo lugar** |
| Bueno para | 3-5 pasos, flujo lineal | 8+ pasos, ramas condicionales |

Con 4 pasos, la **coreografía** alcanza y es más simple. El problema aparece
cuando el flujo crece: con 10 pasos y ramas, **nadie puede responder "¿qué
pasa si el paso 7 falla?" sin leer 7 repositorios distintos**. Ahí conviene un
orquestador explícito — o directamente Temporal / Step Functions, que te dan
la máquina de estados, los timers y los reintentos hechos.

**La regla: coreografía hasta que el flujo deje de caber en tu cabeza.**

Y lo que **no** cambia con ninguna de las dos: cada paso sigue necesitando
outbox e idempotencia. El orquestador también cambia estado y emite comandos —
también necesita outbox.

### ❌ Guardar el estado de la saga sólo en memoria o en Redis

Un flujo que dura minutos u horas **no puede vivir en la memoria de un pod**
que se recicla en cada deploy. Y en Redis tampoco: el estado de la saga es
**el estado de tu negocio** (¿esta orden está pagada?), y eso va en la base
transaccional, en la misma transacción que las transiciones. Si no, volvés al
problema de la doble escritura del caso 01.

### ❌ No persistir `estado_desde`

Sin esa columna no podés detectar un cuelgue, y **el cuelgue es el modo de
falla más común de una saga** — más común que la compensación, que es lo que
todos los tutoriales explican.

## 6. Cómo sabés que funciona

**La alerta número uno — sagas colgadas:**

```sql
SELECT estado, count(*), min(estado_desde) AS la_mas_vieja
FROM orders
WHERE estado IN ('PENDIENTE_PAGO', 'PAGADA', 'REEMBOLSANDO')
  AND estado_desde < now() - interval '10 minutes'
GROUP BY estado;
```

Tiene que dar **cero**. Cualquier valor distinto de cero es una saga que dejó
de avanzar — y como el sistema cree que está todo bien, **esta query es la
única que lo sabe**.

| Métrica | Qué te dice | Umbral |
| --- | --- | --- |
| **Órdenes por estado** (gauge) | La forma del embudo | `PENDIENTE_MANUAL` creciendo = el transportista está mal |
| **Tiempo en cada estado** (histograma) | Dónde se traba el flujo | p99 de `PAGADA` > 1 min = el consumidor de envíos está lento |
| **Tasa de compensaciones** | Rama 3 | Si sube, algo cambió aguas abajo |
| **Compensaciones FALLIDAS** | Reembolsos que no salieron | **Debería ser 0. Es dinero del cliente** |
| **`saga.colgada`** (contador) | Lo que barrió el job | Si el barredor trabaja seguido, el outbox o un consumidor tienen un problema |

La penúltima es la que más duele si falta: una compensación fallida es un
cliente al que le cobraste, no le mandaste nada, **y tampoco le devolviste la
plata**.

**Cómo lo testeás.** Las sagas se testean por **rama**, y las que importan son
las de falla:

```ts
describe('saga de orden', () => {
  it('rama 1: reintenta un fallo transitorio sin molestar al usuario', async () => {
    const orden = await crearOrdenPagada();
    await emitir('shipment.failed', { ordenId: orden.id, motivo: 'PROVEEDOR_CAIDO' });
    expect(await estadoDe(orden.id)).toBe('PAGADA');            // no cambió
    expect(await outboxPendientes(orden.id)).toContainEqual(
      expect.objectContaining({ topic: 'shipment.requested' }),  // reencolado
    );
  });

  it('rama 3: compensa y el reembolso usa clave determinística', async () => {
    const orden = await crearOrdenPagada();
    await emitir('shipment.failed', { ordenId: orden.id, motivo: 'SIN_COBERTURA' });
    expect(await estadoDe(orden.id)).toBe('REEMBOLSANDO');
    const ev = await outboxPendientes(orden.id);
    expect(ev).toContainEqual(expect.objectContaining({
      topic: 'payment.refund_requested',
      payload: expect.objectContaining({ idemKey: `orden-${orden.id}-reembolso` }),
    }));
  });

  it('el evento duplicado no avanza la saga dos veces', async () => {
    const orden = await crearOrdenPendientePago();
    const ev = { ordenId: orden.id, cobroId: 'ch_1' };
    await emitir('payment.succeeded', ev, { eventId: 'e1' });
    await emitir('payment.succeeded', ev, { eventId: 'e1' });    // el mismo
    expect(await outboxPendientes(orden.id).then((x) =>
      x.filter((e) => e.topic === 'shipment.requested'))).toHaveLength(1);
  });

  it('el barredor detecta y reemite una saga colgada', async () => {
    const orden = await crearOrdenPagada({ estadoDesde: hace(10, 'minutos') });
    await vaciarOutbox();                                        // simula el evento perdido
    await barredor.barrerSagasColgadas();
    expect(await outboxPendientes(orden.id)).not.toHaveLength(0);
  });
});
```

Ese último test es el que verifica el caso de la sección 2 forma 2 — el
cuelgue silencioso — y es el que casi nadie escribe porque el bug no se ve.

## 7. El costo

1. **El dominio se llena de estados.** `PENDIENTE_PAGO`, `PAGADA`,
   `PENDIENTE_MANUAL`, `REEMBOLSANDO`... y cada uno necesita saber qué le
   muestra al usuario, qué puede hacer soporte, y cómo se reporta en
   contabilidad. **Es trabajo de producto, no sólo técnico.**
2. **Consistencia eventual visible.** La orden existe sin estar confirmada. El
   front tiene que manejar estados intermedios y el usuario ve "procesando".
3. **Cada paso necesita outbox + idempotencia.** No es opcional: son 3-4
   consumidores idempotentes que hay que escribir y mantener.
4. **Las compensaciones son código de producción que casi nunca corre**, y por
   lo tanto **es el código menos probado del sistema**. Hay que testearlo
   explícitamente o va a estar roto el día que haga falta.
5. **No hay un punto único donde leer el flujo** (el costo de la coreografía).
   Con 4 pasos se tolera; con 10 hay que migrar a orquestación.
6. **El barredor es un componente más** que hay que operar y monitorear.

**Y la alternativa a todo esto** —si el negocio lo permite— es muchísimo más
barata: **no cobrar hasta tener todo reservado**. Autorizar el pago sin
capturarlo, reservar el envío, y recién entonces capturar. La saga sigue
existiendo, pero la rama 3 pasa de "reembolsar" a "liberar la autorización",
que es gratis y no se ve en el resumen del cliente.

**Esa pregunta —"¿podemos no cobrar hasta el final?"— vale más que cualquier
decisión de implementación de este caso**, y conviene hacerla antes de escribir
una línea.

---

## Fuentes

- **Garcia-Molina & Salem**, *Sagas* (SIGMOD 1987) — el paper original:
  <https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf>
- **Chris Richardson**, *Saga pattern*:
  <https://microservices.io/patterns/data/saga.html>
- **Temporal**, *Saga pattern made easy* — el patrón industrializado:
  <https://temporal.io/blog/saga-pattern-made-easy>
- **Caitie McCaffrey**, *Applying the Saga Pattern* (charla) — con casos
  reales de producción: <https://www.youtube.com/watch?v=xDuwrtwYHu8>
- **AWS**, *Saga pattern con Step Functions*:
  <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga.html>

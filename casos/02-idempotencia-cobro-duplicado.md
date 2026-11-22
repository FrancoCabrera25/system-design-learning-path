# Caso 02 — El cobro duplicado que no figura en ningún log

> **Módulos:** [06 (idempotencia)](../modules/06-idempotencia/) ·
> [05 (bases de datos)](../modules/05-bases-de-datos/)
> **Patrón:** Idempotency Key de punta a punta

---

## 1. El escenario

App móvil de pagos. El usuario aprieta "Pagar", el cliente hace
`POST /pagos`, el backend cobra con un proveedor externo.

```
200.000 intenciones de pago por día, de USD 85 promedio
2 %   de las respuestas se pierden   -> el cliente reintenta DESPUÉS
1 %   el cliente reintenta con la primera TODAVÍA EN VUELO (timeout agresivo)
0,4 % el pod muere entre cobrar y commitear (deploy, OOM, spot)
```

Ese 2% no es un número inventado: es la realidad de un cliente móvil. El 4G
se corta, el usuario entra al subte, el sistema operativo suspende la app. La
request salió, el backend la procesó, y **la respuesta nunca llegó al
teléfono**.

## 2. Qué se rompe

El cliente no puede saber si el pago se hizo. Tiene dos opciones y **las dos
son malas**: no reintentar (el usuario cree que no pagó, y quizás pagó) o
reintentar (y quizás pague dos veces). Es el **timeout ambiguo**
([módulo 06, §1](../modules/06-idempotencia/README.md)).

Con el código sin protección, los números de
[`idempotencia.ts`](../modules/06-idempotencia/idempotencia.ts):

```
implementación                     cobros      duplicados    USD cobrados de más
1. sin protección                 205.971         5.971       $ 507.535  💀
```

**Medio millón de dólares al año en cobros duplicados.** Y lo que sigue es la
parte interesante, porque la mayoría de los equipos ya puso *algo*:

```
2. SELECT y después INSERT        201.003         1.003       $  85.255  ⚠️
```

Ese es el arreglo que escribe casi todo el mundo:

```ts
const ya = await this.repo.findOne({ where: { idemKey } });
if (ya) return ya.respuesta;
await this.cobrar(...);
await this.repo.save({ idemKey, respuesta });
```

Y **resuelve el reintento secuencial** —cuando la primera ya commiteó, el
`SELECT` la encuentra— por eso **parece correcto**: anda perfecto en
desarrollo, en staging, y en producción con poca carga. Falla sólo cuando las
dos requests están **en vuelo al mismo tiempo**: las dos hacen el `SELECT`,
las dos no encuentran nada, las dos cobran.

Es el **lost update** del [módulo 05](../modules/05-bases-de-datos/) con otra
ropa: una decisión tomada sobre una lectura que dejó de ser cierta. Y ocurre
con el nivel de aislamiento **por defecto** de Postgres (`READ COMMITTED`), sin
que nada falle.

**Y el caso que nadie espera.** Incluso con un `UNIQUE` impecable:

```
4. UNIQUE, efecto EXTERNO         200.017            17       $   1.445  ⚠️
```

Diecisiete cobros duplicados con la protección bien implementada. ¿Por qué?

```
BEGIN
  INSERT idempotency_key (IN_PROGRESS)   ✅
  cobrar en el proveedor                 ✅  ← LA PLATA YA SALIÓ
  💥 el pod muere
ROLLBACK (implícito)                     ← la marca de idempotencia se revierte
```

La transacción se revierte **y con ella la marca**, pero el cobro no. Al
reintentar, la clave no existe y **se cobra de nuevo**.

Son pocos casos, y ahí está la trampa: **es tan raro que no aparece en ningún
test, nadie lo cree posible, y cuando el cliente reclama no figura en ningún
log** — porque la transacción que lo habría registrado es justamente la que se
revirtió.

## 3. La solución probada

**Idempotency Key de punta a punta**, con nueve eslabones. El patrón está
documentado y estandarizado: es el contrato de **Stripe**, de **PayPal**, de
**Adyen**, y tiene un borrador de IETF (`draft-ietf-httpapi-idempotency-key-header`).

La idea de fondo:

> **No intentes evitar que la operación se ejecute dos veces. Hacé que
> ejecutarla dos veces dé el mismo resultado.**

Y la propiedad que hay que entender:

> **La idempotencia no es una propiedad de tu endpoint: es una propiedad DE
> PUNTA A PUNTA.** Una cadena con ocho eslabones buenos y uno malo **no es
> idempotente.**

## 4. La implementación

### 4.1 El cliente — el eslabón que más se rompe

```ts
// ❌ EL BUG MÁS COMÚN DE TODO EL TEMA
axios.interceptors.request.use((c) => {
  c.headers['Idempotency-Key'] = crypto.randomUUID();   // ← uno NUEVO por intento
  return c;
});
```

Con eso, cada reintento es —para el servidor— una **intención nueva y
legítima**. Tres intentos son tres pagos. Y lo peor: **todo el mecanismo del
servidor está implementado y correcto**, la tabla se llena, el `UNIQUE`
funciona, los tests pasan. Simplemente no protege de nada.

```ts
// ✅ la clave nace con la INTENCIÓN y se persiste
async function pagar(monto: number, destino: string) {
  const pendiente = await storage.getItem('pago-en-curso');
  const intento = pendiente
    ? JSON.parse(pendiente)
    : { key: crypto.randomUUID(), monto, destino };

  // Se guarda en disco: tiene que sobrevivir a que el SO mate la app
  await storage.setItem('pago-en-curso', JSON.stringify(intento));

  try {
    const res = await reintentarConBackoffYJitter(
      () => api.post('/pagos', { monto: intento.monto, destino: intento.destino },
                     { headers: { 'Idempotency-Key': intento.key }, timeout: 15_000 }),
      { intentos: 4, base: 500, techo: 8_000 },
    );
    await storage.removeItem('pago-en-curso');
    return res;
  } catch (e) {
    // NO borramos la clave: el próximo arranque de la app reintenta con LA MISMA
    throw e;
  }
}
```

> **La clave se crea cuando el usuario aprieta el botón, no cuando se
> construye el request.**

### 4.2 El store del servidor

```sql
CREATE TABLE idempotency_keys (
  scope        text        NOT NULL,     -- tenant:endpoint:clave
  estado       text        NOT NULL,     -- IN_PROGRESS | COMPLETED | FAILED
  request_hash text        NOT NULL,     -- para detectar la clave reusada
  status_code  int,
  respuesta    jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope)                    -- ← ACÁ está la garantía
) PARTITION BY RANGE (created_at);       -- se dropea por día, no se borra
```

El `PRIMARY KEY` **no es una regla lógica: es una estructura física**. El
segundo `INSERT` no "consulta y decide": intenta escribir en un índice B-tree
donde ya hay una entrada, y el motor lo bloquea **por debajo del sistema de
snapshots**. Funciona igual en `READ COMMITTED` que en `SERIALIZABLE`.

```ts
@Injectable()
export class IdempotencyStore {
  /** Transacción CORTA y PROPIA. Es deliberado: ver §5. */
  async reclamar(scope: string, hash: string): Promise<Reclamo> {
    const insert = await this.dataSource.createQueryBuilder()
      .insert().into(IdempotencyKey)
      .values({ scope, estado: 'IN_PROGRESS', requestHash: hash })
      .orIgnore()                                   // ON CONFLICT DO NOTHING
      .execute();

    if (insert.identifiers.length > 0) return { tipo: 'GANAMOS' };

    const previa = await this.repo.findOneBy({ scope });

    if (previa.requestHash !== hash) return { tipo: 'PAYLOAD_DISTINTO' };

    if (previa.estado === 'COMPLETED')
      return { tipo: 'REPETIDA', statusCode: previa.statusCode, respuesta: previa.respuesta };

    if (previa.estado === 'FAILED' && previa.statusCode >= 500) {
      // Falló transitoriamente: liberamos para que el reintento SÍ se ejecute
      await this.repo.update({ scope }, { estado: 'IN_PROGRESS' });
      return { tipo: 'GANAMOS' };
    }
    if (previa.estado === 'FAILED')
      return { tipo: 'REPETIDA', statusCode: previa.statusCode, respuesta: previa.respuesta };

    // IN_PROGRESS: hay otra request viva con esta clave
    const antiguedadMs = Date.now() - previa.createdAt.getTime();
    if (antiguedadMs > 5 * 60_000) {                // abandonada: la recuperamos
      await this.repo.update({ scope }, { estado: 'IN_PROGRESS', createdAt: new Date() });
      return { tipo: 'GANAMOS' };
    }
    return { tipo: 'EN_CURSO' };
  }
}
```

### 4.3 El interceptor

```ts
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    const clave = req.headers['idempotency-key'];
    if (!clave) throw new BadRequestException('Idempotency-Key requerida');

    // ALCANCE: sin el tenant, le devolvés la respuesta de otro cliente (§5)
    const scope = `${req.user.tenantId}:${req.route.path}:${clave}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

    const r = await this.store.reclamar(scope, hash);

    if (r.tipo === 'REPETIDA') {
      ctx.switchToHttp().getResponse().status(r.statusCode).set('Idempotent-Replay', 'true');
      return of(r.respuesta);
    }
    if (r.tipo === 'EN_CURSO')
      throw new ConflictException('Hay una request en curso con esta clave');
    if (r.tipo === 'PAYLOAD_DISTINTO')
      throw new UnprocessableEntityException('Clave reusada con otro payload');

    return next.handle().pipe(
      tap((res) => this.store.completar(scope, 200, res)),
      catchError((e) => { this.store.fallar(scope, e.status ?? 500, e.response); throw e; }),
    );
  }
}
```

### 4.4 El eslabón que casi todos olvidan: el proveedor

Acá se cierran los 17 cobros del escenario 4.

```ts
await this.stripe.charges.create(
  { amount, currency: 'ars', customer },
  { idempotencyKey: `orden-${ordenId}-cobro` },   // ← DETERMINÍSTICA, derivada del negocio
);
```

**Determinística**: derivada del negocio, no un `uuid()` nuevo. Si el reintento
genera otra clave, para Stripe son dos cobros distintos y no deduplica nada.

**Y si el proveedor no soporta claves de idempotencia** (pasa seguido con APIs
viejas), el patrón es **registrar la intención antes de ejecutar**:

```ts
// 1. commit propio: queda registro de que ESTAMOS POR cobrar
await this.repo.save(IntentoCobro, { id: intentoId, ordenId, estado: 'PENDIENTE' });

// 2. ahora sí, el efecto externo
const res = await this.proveedor.cobrar({ monto, referencia: intentoId });

// 3. commit propio: quedó hecho
await this.repo.update(intentoId, { estado: 'HECHO', respuesta: res });
```

Si el proceso muere entre 1 y 3, al reintentar encontrás un `PENDIENTE` y
sabés que **puede** haberse ejecutado. Ahí **le preguntás al proveedor**
(`GET /charges?reference=...`) antes de reintentar a ciegas. No es elegante,
es lo que hay, y saber explicarlo vale mucho.

## 5. Por qué así y no de otra forma

### ❌ `SELECT` y después `INSERT`

Es el arreglo que escribe el 90% de la gente y **resuelve sólo la mitad del
problema**: cubre el reintento secuencial y falla con el concurrente. En la
simulación: 1.003 cobros duplicados al año, USD 85.255.

Lo peligroso es que **parece funcionar**. El race dura microsegundos, así que
no aparece en los tests, no aparece en staging, y en producción aparece en el
1% de los casos — suficiente para costar plata, poco suficiente para que
nadie lo encuentre mirando el código.

### ❌ Subir el aislamiento a `SERIALIZABLE`

Técnicamente funciona: Postgres detecta el conflicto y aborta una con `40001`.
Pero:

- Tu código **tiene que reintentar**. Si no, cambiaste un cobro duplicado por
  un error 500 — y es peor, porque ahora falla en el caso **sano**.
- Agrega overhead de seguimiento de dependencias en **toda** la transacción.
- Bajo contención, la tasa de abortos sube y te metés en reintentos que
  compiten entre sí.

**Es una solución pesada para algo que un `UNIQUE` resuelve gratis y sin
abortos.**

### ❌ Un lock distribuido sobre la clave

```ts
const lock = await redis.set(`lock:${clave}`, token, 'NX', 'PX', 30_000);
if (!lock) throw new ConflictException();
```

Tres problemas, todos del [módulo 06, §7](../modules/06-idempotencia/README.md):

1. **TTL vs duración del trabajo.** Un cobro de 4 s con un TTL de 30 s parece
   seguro hasta que una pausa de GC de 35 s hace que el lock expire **mientras
   seguís cobrando**.
2. **El failover de Redis** puede otorgar el mismo lock dos veces (replicación
   asíncrona).
3. **Agregás una dependencia** al camino crítico de un pago.

Y lo decisivo: **el lock reduce la probabilidad de la doble ejecución; el
`UNIQUE` elimina su consecuencia.** La segunda es estrictamente mejor.

### ❌ Que el servidor genere la clave

Parece más seguro —el servidor controla— y **rompe el mecanismo entero**: si
el servidor la genera, el cliente no tiene qué repetir al reintentar. La clave
identifica una **intención**, y la intención nace en el cliente.

### ❌ No guardar el hash del request

Sin el hash, una clave reusada con otro payload te devuelve la respuesta del
primero. Si alguien manda la misma clave con `{monto: 100}` y después con
`{monto: 5000}`, **le confirmás un pago de 5.000 que nunca ocurrió**. Es peor
que fallar.

### ❌ Meter la fila `IN_PROGRESS` en la transacción del pago

Parece más limpio —una sola transacción— y bajo carga te mata:

1. La segunda request hace su `INSERT` sobre la misma clave y **se queda
   bloqueada** hasta que la primera commitee o aborte.
2. Con un cobro de 4 segundos, esa request tiene **una conexión del pool
   tomada 4 segundos sin hacer nada**.
3. Con reintentos agresivos, **el pool se agota** y se lleva puestos endpoints
   que no tienen nada que ver ([módulo 01, C2](../modules/01-fundamentos/respuestas.md)).
4. Y **no podés devolver `409`**, porque no ves la fila: está sin commitear.

### ❌ Esperar y devolver el resultado de la primera

Suena más amable que un `409` y convierte **cada reintento en una conexión
bloqueada**. Con un timeout agresivo del cliente, tenés N conexiones esperando
un resultado que el cliente ya no va a leer. `409 + Retry-After` es la
respuesta correcta, y es lo que hace Stripe.

### ❌ Un TTL de claves muy corto

"Las guardamos una hora, total el reintento es inmediato." Falso para un
cliente móvil: **recupera conectividad dos horas después y reintenta con una
clave que ya expiró** → duplica. 24 horas es el estándar, y se limpia
dropeando particiones, no con un `DELETE` sobre una tabla caliente.

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **Tasa de `Idempotent-Replay`** | Cuántos reintentos estás absorbiendo | Si es **0**, tu mecanismo no está conectado |
| **Tasa de `409`** | Reintentos concurrentes | Si sube, los clientes tienen el timeout muy agresivo |
| **Tasa de `422`** | Claves reusadas con otro payload | **Siempre es un bug de un cliente.** Debería ser 0 |
| **`IN_PROGRESS` con más de 5 min** | Requests abandonadas | Si crece, hay procesos muriendo a mitad |
| **Cobros sin `IntentoCobro` en estado `HECHO`** | El caso de los 17 | Debería ser 0 |

La primera es la más importante y la más contraintuitiva: **una tasa de replay
de cero no significa que no haya duplicados — significa que no estás
deduplicando nada.** Con 200.000 pagos y 2% de respuestas perdidas, esperás
~4.000 replays por día. Si ves cero, buscá el `uuid()` en el interceptor del
cliente.

**El job de reconciliación**, que es la red de última instancia:

```sql
-- Cobros en el proveedor sin su contraparte confirmada de nuestro lado
SELECT i.id, i.orden_id, i.created_at
FROM intentos_cobro i
WHERE i.estado = 'PENDIENTE'
  AND i.created_at < now() - interval '10 minutes';
```

**Cómo lo testeás:** los dos casos que importan son concurrencia y muerte a
mitad, y ninguno sale de un test unitario.

```ts
it('con dos requests concurrentes y la misma clave, cobra UNA vez', async () => {
  const key = crypto.randomUUID();
  const [a, b] = await Promise.allSettled([pagar(key, 100), pagar(key, 100)]);
  expect(cobrosEnProveedor()).toHaveLength(1);
  // uno gana con 201, el otro recibe 409 o la respuesta repetida
  expect([a, b].filter((r) => r.status === 'fulfilled')).not.toHaveLength(0);
});

it('no vuelve a cobrar si el pod muere entre cobrar y commitear', async () => {
  const key = crypto.randomUUID();
  jest.spyOn(dataSource, 'transaction').mockImplementationOnce(async (fn) => {
    await fn(txFalso);                // cobra...
    throw new Error('pod muerto');    // ...y el commit nunca llega
  });
  await pagar(key, 100).catch(() => {});
  await pagar(key, 100);              // el reintento
  expect(cobrosEnProveedor()).toHaveLength(1);   // ← falla sin la clave del proveedor
});
```

Ese segundo test es el que detecta los 17 cobros del escenario 4, y es el que
casi nadie escribe.

## 7. El costo

1. **Un contrato nuevo con los clientes.** El header pasa a ser obligatorio, y
   hay que coordinar con cada cliente (web, iOS, Android, integraciones). Es
   trabajo de comunicación, no de código.
2. **Una tabla de alta rotación** que hay que particionar y limpiar.
3. **Un `409` que los clientes tienen que entender.** Si lo tratan como error
   genérico y lo muestran al usuario, empeoraste la UX.
4. **Latencia extra**: una transacción corta más por request (~2-5 ms).
5. **El TTL es una decisión de negocio disfrazada de config.** 24 h cubre a un
   cliente móvil; si tus clientes pueden reintentar a los 3 días, hay que
   saberlo de antemano.

---

## Fuentes

- **Stripe**, *Idempotent requests* — el contrato de referencia:
  <https://docs.stripe.com/api/idempotent_requests>
- **AWS Builders' Library**, *Making retries safe with idempotent APIs*:
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
- **IETF**, `draft-ietf-httpapi-idempotency-key-header` — la estandarización
  del header: <https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>
- **Postgres**, *Transaction Isolation* — por qué `READ COMMITTED` deja pasar
  esto: <https://www.postgresql.org/docs/current/transaction-iso.html>

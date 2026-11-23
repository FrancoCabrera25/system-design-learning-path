# Caso 07 — "A veces no se guarda"

> **Módulos:** [05 (bases de datos)](../modules/05-bases-de-datos/)
> **Patrón:** Read-your-writes (sticky reads al primario + respuesta del POST)

---

## 1. El escenario

App de gestión en NestJS con Postgres. Para aliviar al primario, las lecturas
se mandan a una réplica.

```ts
// La optimización que todo el mundo hace, y está bien hecha
@Injectable()
export class UserService {
  constructor(
    @InjectDataSource('primario')  private primario: DataSource,
    @InjectDataSource('replica')   private replica: DataSource,
  ) {}

  guardar(dto: UpdateUserDto) { return this.primario.getRepository(User).save(dto); }
  obtener(id: string)         { return this.replica.getRepository(User).findOneBy({ id }); }
}
```

```
500 escrituras/s
ratio lectura/escritura 12:1
lag de la réplica:  p50 19 ms · p90 29 ms · p99 400 ms · p99.9 7 s
```

El front es una SPA: después del `PATCH /perfil` dispara un `GET /perfil` para
refrescar la pantalla.

## 2. Qué se rompe

**El síntoma:** los usuarios reportan que *"a veces no se guarda"*. Editan su
perfil, la pantalla se recarga, y **ven los datos de antes**. Si recargan de
nuevo, aparece bien.

Y el ticket se cierra como **"no reproducible"**, porque:

- El `PATCH` devolvió **200**.
- El `GET` devolvió **200**.
- **No hay un solo error en ningún log.**
- La base está sana. El lag de la réplica es de **19 ms** en el dashboard:
  nadie cree que 19 milisegundos puedan causar algo.
- Y cuando el desarrollador lo prueba a mano, **funciona perfecto**.

**La causa:** rompiste **read-your-writes**. El `PATCH` escribe en el primario
y el `GET` lee de una réplica que todavía no recibió el cambio.

Y acá está el número que da vuelta la intuición
([`replication-lag.ts`](../modules/05-bases-de-datos/replication-lag.ts)):

```
cuándo relee el front           % que ve datos VIEJOS
inmediatamente (SPA refetch)         100.00 %   💀
50 ms después                          7.60 %   ⚠️
500 ms después                         0.99 %   ✅
3 s (el usuario aprieta F5)            0.65 %   ✅
```

> **Con un lag p50 de 19 ms, el refetch inmediato de una SPA falla
> prácticamente SIEMPRE.** Y el desarrollador que lo prueba a mano tarda 3
> segundos en mirar, así que falla menos del 1% de las veces.

**El bug es una carrera de milisegundos, y el humano que lo investiga es
demasiado lento para dispararlo.** Por eso se cierra como no reproducible, y
por eso vuelve cada dos semanas.

A 500 escrituras/s, eso son **500 usuarios por segundo** viendo "no se
guardó".

**Y el caso grave que nadie monitorea:** durante una migración, un `VACUUM`
pesado o un batch nocturno, el lag salta a **2-30 segundos**. Ahí incluso el
usuario que espera 3 segundos ve datos viejos el 90% de las veces. Y lo peor:

- **La aplicación no se cae.** Responde 200 a todo, con datos de hace medio
  minuto.
- Los usuarios **crean cosas duplicadas** porque "no aparecieron".
- **Cancelan operaciones que sí ocurrieron.**
- Y las métricas de error están en **cero**.

## 3. La solución probada

**Read-your-writes**: la garantía de que un usuario ve **sus propias**
escrituras. Es una de las garantías de consistencia de sesión que describe
Kleppmann en *DDIA* (cap. 5), y la implementan por defecto DynamoDB con
lecturas consistentes, Azure Cosmos DB como nivel de consistencia, y Vitess
con su modo `@primary`.

Y la clave del caso es que **no se resuelve con una sola técnica, sino con
cuatro, ordenadas por costo**:

| | Solución | Costo | Cubre |
| --- | --- | --- | --- |
| 1 | **Que el `POST`/`PATCH` devuelva el recurso** | **Cero** | El caso más común (el refetch inmediato) |
| 2 | **Leer del primario por N segundos después de escribir** | Bajo | Todo lo que lea ese usuario |
| 3 | **Esperar el LSN** | Medio | Correcto de verdad |
| 4 | **Leer siempre del primario** | Alto | Todo, y tira a la basura las réplicas |

Y la pregunta que ordena la decisión, que es **por endpoint**:

> **¿Qué lecturas de este sistema NECESITAN read-your-writes?**
> Casi nunca son todas.

## 4. La implementación

### 4.1 La solución más barata: no hagas la segunda query

```ts
// ❌ ANTES: el front escribe y vuelve a leer
@Patch(':id')
async actualizar(@Param('id') id: string, @Body() dto: UpdateUserDto) {
  await this.primario.getRepository(User).save({ id, ...dto });
  return { ok: true };                       // ← el front ahora hace GET
}

// ✅ DESPUÉS: devolvé el recurso actualizado
@Patch(':id')
async actualizar(@Param('id') id: string, @Body() dto: UpdateUserDto) {
  const usuario = await this.primario.getRepository(User).save({ id, ...dto });
  return usuario;                            // ← el front usa esto, no relee
}
```

```ts
// Y en el front: usar la respuesta, no refetchear
const actualizado = await api.patch(`/users/${id}`, cambios);
queryClient.setQueryData(['user', id], actualizado);   // ← NO invalidateQueries
```

**Costo cero, y resuelve el caso que falla el 100% de las veces.** Es la
solución más efectiva de las cuatro y la que menos se aplica, porque el patrón
reflejo de React Query / SWR es `invalidateQueries` — que es exactamente el
refetch inmediato que rompe.

### 4.2 Sticky reads al primario: una ventana por sesión

Cubre todo lo que ese usuario lea después de escribir, no sólo el recurso que
tocó.

```ts
/** Marca la sesión como "escribió hace poco" en Redis. */
@Injectable()
export class VentanaEscritura {
  private readonly VENTANA_S = 5;

  async marcar(sesionId: string) {
    await this.redis.set(`rw:${sesionId}`, Date.now(), 'EX', this.VENTANA_S);
  }
  async escribioHacePoco(sesionId: string): Promise<boolean> {
    return (await this.redis.exists(`rw:${sesionId}`)) === 1;
  }
}
```

```ts
/** El router de lecturas: una sola decisión, en un solo lugar. */
@Injectable()
export class DbRouter {
  async paraLectura(req: Request): Promise<DataSource> {
    // Opt-in explícito del endpoint: algunas lecturas SIEMPRE van al primario
    if (Reflect.getMetadata('consistencia-fuerte', req.handler)) return this.primario;

    if (await this.ventana.escribioHacePoco(req.session.id)) {
      this.metricas.increment('lectura.al_primario', { motivo: 'ventana_rw' });
      return this.primario;
    }
    return this.replica;
  }
}
```

```ts
// Un interceptor abre la ventana en cada escritura. Nadie tiene que acordarse.
@Injectable()
export class VentanaEscrituraInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    const esEscritura = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    return next.handle().pipe(
      tap(() => { if (esEscritura) this.ventana.marcar(req.session.id); }),
    );
  }
}
```

**El costo medido**, que es lo que hace a esta solución viable: con un ratio
12:1 y ~2,5 lecturas arrastradas por escritura, mandás al primario el **~20%**
de las lecturas. **Seguís descargándolo del 80%** — o sea, conservás casi todo
el beneficio de tener réplicas.

Y si el sistema no tiene sesión (una API con tokens), el mismo mecanismo
funciona con una **cookie firmada** con el timestamp de la última escritura, o
con el `sub` del JWT como clave.

### 4.3 La versión correcta de verdad: esperar el LSN

```ts
// El POST devuelve la posición en el WAL donde quedó la escritura
@Patch(':id')
async actualizar(@Param('id') id: string, @Body() dto: UpdateUserDto, @Res({ passthrough: true }) res) {
  const usuario = await this.primario.transaction(async (tx) => {
    const u = await tx.getRepository(User).save({ id, ...dto });
    const [{ lsn }] = await tx.query(`SELECT pg_current_wal_insert_lsn() AS lsn`);
    res.setHeader('X-Consistency-Token', lsn);
    return u;
  });
  return usuario;
}
```

```ts
// La lectura espera a que la réplica alcance ese LSN, o cae al primario
async leerConsistente(token: string | undefined, fn: (ds: DataSource) => Promise<any>) {
  if (!token) return fn(this.replica);

  const [{ alcanzado }] = await this.replica.query(
    `SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS alcanzado`, [token],
  );
  if (alcanzado) return fn(this.replica);

  // Esperamos un poquito; si no llega, vamos al primario
  const ok = await this.esperarLsn(token, 50);
  this.metricas.increment('lsn.espera', { resultado: ok ? 'alcanzado' : 'fallback' });
  return fn(ok ? this.replica : this.primario);
}
```

Es **correcto por construcción**: no asume una ventana de tiempo, verifica el
hecho. El costo es que hay que **plomear el token por toda la aplicación** —
el front tiene que guardarlo y devolverlo en cada lectura relacionada.

Vale la pena para endpoints críticos, y es sobre-ingeniería como política
general.

### 4.4 Monotonic reads: la anomalía hermana

Hay un segundo bug, más sutil, que aparece cuando hay **varias réplicas**:

```
GET /comentarios  -> réplica A (lag 15 ms)   -> ve el comentario nuevo  ✅
GET /comentarios  -> réplica B (lag 800 ms)  -> el comentario DESAPARECIÓ  💀
```

El usuario ve algo y al refrescar **ya no está**. Es la violación de
**monotonic reads**, y para el usuario es más inquietante que el caso original
— parece que el sistema perdió datos.

```ts
// Se arregla pegando cada sesión a la MISMA réplica (sticky reads)
elegirReplica(sesionId: string): DataSource {
  const idx = murmur2(sesionId) % this.replicas.length;   // estable por sesión
  return this.replicas[idx];
}
```

Una línea, y elimina la clase entera. Si la réplica elegida se cae, se
recalcula — se pierde la garantía en ese instante, que es un intercambio
razonable.

### 4.5 La alerta que faltaba

```sql
-- En la RÉPLICA. Sin esto, un pico de lag es completamente invisible.
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```

```yaml
- alert: ReplicaLagAlto
  expr: pg_replication_lag_seconds > 2
  for: 30s
  annotations:
    summary: "Lag de réplica > 2 s: las lecturas pueden devolver datos viejos"
    runbook: "Mandar todas las lecturas al primario hasta que baje"
```

Y el *kill switch* que hay que tener preparado **antes** de necesitarlo:

```ts
// Un flag que manda TODO al primario, para usar durante una migración
if (await this.flags.enabled('forzar-lecturas-al-primario')) return this.primario;
```

## 5. Por qué así y no de otra forma

### ❌ "El lag es de 19 ms, no puede ser eso"

Es la frase que hace que este bug sobreviva meses. **19 ms es muchísimo
cuando el front relee en 5 ms.** La simulación lo mide: el refetch inmediato
falla el **100%** de las veces con ese lag.

El error de razonamiento es comparar el lag contra la **percepción humana**
(19 ms es imperceptible) en vez de contra **la velocidad del front** (que
dispara el `GET` en el siguiente tick del event loop).

### ❌ "Agregamos un `setTimeout(500)` antes del refetch"

Baja la tasa de fallo de 100% a ~1%, así que **parece que funciona** — y es la
peor solución de la lista:

1. **Agrega 500 ms de latencia percibida a todas las ediciones**, para siempre.
2. **Sigue fallando el 1% de las veces**, y ese 1% es el que vuelve a soporte.
3. **No cubre el pico**: cuando el lag salta a 7 s (p99.9), el `setTimeout`
   de 500 ms no sirve de nada.
4. Es un número mágico que **nadie va a poder justificar** en seis meses.

Cambia un bug reproducible por uno más raro. **Hacerlo más difícil de
reproducir no es arreglarlo.**

### ❌ "Leemos siempre del primario"

Resuelve el problema y **tira a la basura la razón por la que tenías
réplicas**: el primario vuelve a recibir el 100% de las lecturas (13 veces más
carga con ratio 12:1).

Es válido para **endpoints puntuales** —el perfil que el usuario acaba de
editar, el saldo de una cuenta— y **no como política general**. La diferencia
entre las dos cosas es lo que hace que la solución 2 exista.

### ❌ "Replicación síncrona"

Elimina el lag de raíz (`synchronous_commit = on` con
`synchronous_standby_names`) y el costo es serio:

- **Cada commit paga el round-trip a la réplica**: +1-2 ms entre AZs, mucho
  más entre regiones. A 500 escrituras/s, eso es latencia en el camino
  crítico de cada escritura.
- **Si la réplica se cae o se atrasa, los commits se FRENAN.** Convertiste una
  réplica de lectura —un componente opcional— en una **dependencia crítica de
  tu capacidad de escribir**. Es exactamente la trampa de disponibilidad
  compuesta del [módulo 02](../modules/02-comunicacion-servicios/README.md).

Para un sistema financiero donde no podés perder una escritura confirmada en
un failover, puede ser la decisión correcta. Para arreglar "a veces no se
guarda", es desproporcionado.

### ❌ "Cacheamos el valor escrito en Redis y lo leemos de ahí"

Parece ingenioso: escribís en el primario **y** en Redis, y lees de Redis
primero. Y lo que estás haciendo es **mover el problema**:

- Ahora tenés **dos** fuentes de verdad desincronizables, con el race de
  cache-aside del [módulo 04, C2](../modules/04-caching/respuestas.md).
- Y una **doble escritura** sin transacción que las abarque: el problema del
  [caso 01](01-outbox-el-evento-que-nunca-salio.md).

Cambiaste un problema de consistencia por dos.

### ⚠️ "Usamos el LSN siempre"

Es la solución **correcta** y tiene un costo de plumbing real: el token tiene
que viajar del `POST` al front, el front tiene que guardarlo y devolverlo en
cada lectura relacionada, y hay que decidir qué pasa si el cliente no lo
manda. Para 3 endpoints críticos, vale. Para 200, no.

### ✅ La pregunta que ordena todo

> **¿Qué lecturas de este sistema necesitan read-your-writes?**

| Lectura | ¿Necesita? |
| --- | --- |
| El perfil que el usuario acaba de editar | **Sí** |
| El saldo después de una transferencia | **Sí** |
| El estado de una orden que acaba de crear | **Sí** |
| El listado de productos | No |
| El feed, las notificaciones, el buscador | No |
| Reportes y analytics | No (y conviene que vayan a réplica) |

**Es una decisión por endpoint, no una configuración global.** Plantearlo así
—y no "¿nuestra base es consistente?"— es lo que distingue una respuesta de
senior ([módulo 05, A7](../modules/05-bases-de-datos/respuestas.md)).

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **Lag de réplica** (segundos), por réplica | Lo básico, y no estaba | **> 2 s** |
| **p99 del lag**, no el promedio | El p50 de 19 ms oculta un p99.9 de 7 s | Tendencia |
| **% de lecturas que van al primario** | El costo de la solución 2 | **> 35%** = la ventana es muy larga |
| **`lsn.espera` con resultado `fallback`** | Cuántas veces la réplica no llegó | Pico = lag alto |
| **Lecturas a réplica dentro de X ms de una escritura de la misma sesión** | **La métrica que detecta el bug** | **> 0** = hay un camino sin router |

La última es la más valiosa y la que nadie tiene: instrumentar el router para
contar **cuántas lecturas deberían haber ido al primario y no fueron**. Si es
mayor a cero, hay un endpoint que no pasa por el router — que es exactamente
cómo este bug vuelve seis meses después.

**Cómo lo testeás — y acá está la clave, porque el test obvio no sirve:**

```ts
// ❌ ESTE TEST PASA Y EL BUG SIGUE AHÍ
it('guarda el perfil', async () => {
  await api.patch('/users/1', { nombre: 'Ana' });
  const r = await api.get('/users/1');
  expect(r.data.nombre).toBe('Ana');     // ← pasa, porque en test no hay réplica
});
```

El test no reproduce el bug porque **el entorno de test tiene una sola base**.
Hay que **inyectar el lag**:

```ts
describe('read-your-writes', () => {
  beforeEach(() => replica.setLag(50));   // réplica con 50 ms de atraso

  it('lee del primario inmediatamente después de escribir', async () => {
    await api.patch('/users/1', { nombre: 'Ana' });
    const r = await api.get('/users/1');            // SIN esperar
    expect(r.data.nombre).toBe('Ana');
    expect(metricas.get('lectura.al_primario')).toBe(1);   // ← fue al primario
  });

  it('vuelve a la réplica cuando pasa la ventana', async () => {
    await api.patch('/users/1', { nombre: 'Ana' });
    await avanzarReloj(6_000);                       // la ventana es de 5 s
    await api.get('/users/1');
    expect(metricas.get('lectura.a_replica')).toBe(1);
  });

  it('con lag alto, el LSN cae al primario', async () => {
    replica.setLag(8_000);
    const res = await api.patch('/users/1', { nombre: 'Ana' });
    const r = await api.get('/users/1', {
      headers: { 'X-Consistency-Token': res.headers['x-consistency-token'] },
    });
    expect(r.data.nombre).toBe('Ana');
  });
});
```

Y el que protege de la regresión: un test que **recorra todos los endpoints de
lectura** y verifique que pasan por el router. Es un test de arquitectura:

```ts
it('ningún endpoint de lectura usa la réplica directamente', () => {
  const infractores = buscarEnCodigo(/@InjectDataSource\(['"]replica['"]\)/)
    .filter((f) => !f.includes('db-router'));
  expect(infractores).toEqual([]);    // sólo el router toca la réplica
});
```

## 7. El costo

1. **El primario recibe ~20% de las lecturas** con la solución 2. Perdés parte
   del beneficio de las réplicas — a cambio de corrección.
2. **Redis entra en el camino de lectura** (el `exists` de la ventana): +1 ms
   por request y una dependencia más. Se puede evitar con una cookie firmada,
   a costa de confiar en el cliente.
3. **La ventana de 5 s es un número mágico.** Muy corta y el bug vuelve; muy
   larga y el primario recibe demasiado. Hay que derivarla del **p99.9 del
   lag**, no elegirla.
4. **El LSN es plumbing en toda la aplicación**: header en el POST, storage en
   el front, header en el GET.
5. **Sticky reads desbalancea las réplicas**: una sesión muy activa carga
   siempre la misma.
6. **Un camino de código más que mantener.** Cada endpoint nuevo tiene que
   pasar por el router, y el que no lo haga reintroduce el bug en silencio —
   de ahí el test de arquitectura.

**Y lo que no cuesta nada: la solución 1.** Devolver el recurso en el `POST` y
que el front use esa respuesta en vez de refetchear. Resuelve el caso que
falla el 100% de las veces, con cero infraestructura. **Si sólo vas a hacer
una cosa de este caso, hacé esa.**

---

## Fuentes

- **Kleppmann**, *DDIA* cap. 5 — *Reading Your Own Writes*, *Monotonic Reads* y
  el resto de las garantías de consistencia de sesión.
- **Postgres**, *Monitoring replication*:
  <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW>
- **Postgres**, funciones de LSN (`pg_current_wal_insert_lsn`,
  `pg_last_wal_replay_lsn`):
  <https://www.postgresql.org/docs/current/functions-admin.html>
- **Vitess**, *Transaction consistency and read-your-writes*:
  <https://vitess.io/docs/reference/features/mysql-replication/>
- **Azure Cosmos DB**, *Consistency levels* — el menú de garantías explicado
  con ejemplos: <https://learn.microsoft.com/azure/cosmos-db/consistency-levels>

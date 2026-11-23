# Caso 09 — De 4 a 6 shards sin downtime

> **Módulos:** [05 (bases de datos)](../modules/05-bases-de-datos/) ·
> [03 (escalabilidad)](../modules/03-escalabilidad/)
> **Patrón:** Shards lógicos + tabla de ruteo · expand / migrate / contract

---

## 1. El escenario

SaaS multi-tenant con la base shardeada por tenant desde hace tres años.

```ts
const shard = shards[hash(tenantId) % shards.length];   // 4 shards
```

```
4 shards de Postgres · 2.800 tenants · 11 TB en total
los 4 primarios al 78% de CPU en hora pico
el working set del shard 2 dejó de entrar en RAM: su p99 se duplicó
no hay instancia más grande disponible en esa familia
```

Las lecturas ya van a réplicas, los índices están revisados, hay PgBouncer, el
particionado por tiempo está hecho y lo frío está en S3. **El cuello de botella
es el throughput de escritura del primario**, que es lo único que las réplicas
no pueden ayudar a escalar
([módulo 03, D2](../modules/03-escalabilidad/respuestas.md)).

Hay que pasar a 6 shards.

## 2. Qué se rompe

El problema no es un incidente: es que **la operación obvia es imposible**.

Cambiar `% 4` por `% 6` remapea casi todo. Como `lcm(4, 6) = 12`, alcanza con
mirar los 12 restos posibles:

| `hash % 12` | `% 4` | `% 6` | ¿se queda? |
| --- | --- | --- | --- |
| 0, 1, 2, 3 | 0, 1, 2, 3 | 0, 1, 2, 3 | ✅ |
| 4 a 11 | — | — | ❌ |

**Se quedan 4 de 12 = 33%. Se mueve el 67%.**

```
67% de 11 TB = 7,4 TB de datos que tienen que cambiar de máquina
```

Y el modo de falla, si alguien hace el cambio y deploya:

```
1. Se deploya el código con % 6
2. El tenant "acme" pasa del shard 1 al shard 5
3. En el shard 5 no hay NADA de acme
4. acme ve su cuenta VACÍA: cero órdenes, cero usuarios, cero facturas
5. Y empieza a escribir ahí, así que ahora sus datos están PARTIDOS
   entre dos shards, y ninguno de los dos tiene la verdad completa
```

> **Eso último es lo que hace que no haya vuelta atrás.** Revertir el deploy
> manda al tenant al shard 1, donde faltan las escrituras de los últimos
> minutos. Perdiste datos en las dos direcciones.

Y las dos opciones que parecen razonables tampoco sirven:

- **Ventana de mantenimiento:** copiar 7,4 TB a velocidad razonable (sin
  matar las bases) son **18-30 horas**. Un SaaS B2B con clientes en tres
  continentes no tiene esa ventana.
- **Copiar "en caliente" y cambiar el flag:** las escrituras que llegan
  **durante** las 20 horas de copia van al shard viejo, y el nuevo nace
  desactualizado. ¿Cuánto? No se sabe.

## 3. La solución probada

Dos piezas, y la primera es la que cambia el problema de categoría.

### Shards lógicos con tabla de ruteo

```
❌ ANTES                              ✅ DESPUÉS
shard = hash(tenant) % 4              shard_lógico = hash(tenant) % 1024   ← FIJO PARA SIEMPRE
                                      shard_físico = ruteo[shard_lógico]   ← esto cambia
```

Con 1024 shards lógicos y 4 físicos, cada máquina tiene 256. Para pasar a 6,
movés **341 shards lógicos** y actualizás la tabla de ruteo.

| | `% N` físico | Consistent hashing | **Shards lógicos** |
| --- | --- | --- | --- |
| Se mueve | 67% | 33% | 33% |
| Unidad de movimiento | Clave por clave | Clave por clave | **Un shard lógico entero** |
| ¿Sabés qué se mueve? | Hay que calcularlo | Idem | **Es una lista de 341 ids** |
| ¿Reversible a mitad? | **No** | No | **Sí, shard por shard** |
| Radio de daño de un error | 100% de los tenants | 100% | **0,1%** |

Es lo que hacen **Vitess** (keyspaces y shards), **Citus** (shards lógicos
sobre nodos), **Redis Cluster** (16.384 hash slots) y **DynamoDB**
internamente. **No es una idea: es cómo se shardea en serio.**

### Expand / migrate / contract

El mismo patrón que la evolución de contratos del
[módulo 02](../modules/02-comunicacion-servicios/README.md) y las migraciones
de esquema del [módulo 05](../modules/05-bases-de-datos/), aplicado a datos.

> **La regla que gobierna todo: en ningún momento puede existir un estado del
> que no puedas volver.**

## 4. La implementación

### 4.1 La capa de ruteo (fase 0: antes de mover un solo byte)

```sql
-- En una base de metadatos CHICA, replicada, separada de los shards
CREATE TABLE shard_routing (
  shard_logico int  PRIMARY KEY,          -- 0..1023
  shard_fisico text NOT NULL,             -- 'pg-shard-1' ... 'pg-shard-6'
  estado       text NOT NULL DEFAULT 'ESTABLE',
    -- ESTABLE | COPIANDO | DOBLE_ESCRITURA | VERIFICANDO | CAMBIANDO
  destino      text,                      -- a dónde va, mientras migra
  version      int  NOT NULL DEFAULT 0,
  actualizado  timestamptz NOT NULL DEFAULT now()
);
```

```ts
@Injectable()
export class ShardRouter {
  private tabla = new Map<number, Ruta>();

  // La tabla es chica (1024 filas) y cambia poco: se cachea y se invalida por pub/sub
  @Interval(1_000)
  async refrescar() {
    const filas = await this.meta.query(`SELECT * FROM shard_routing`);
    this.tabla = new Map(filas.map((f) => [f.shard_logico, f]));
  }

  logico(tenantId: string): number {
    return hash(tenantId) % 1024;          // ← NUNCA cambia. Es el contrato.
  }

  /** A dónde escribir. Durante la migración, puede ser a DOS lugares. */
  paraEscritura(tenantId: string): string[] {
    const r = this.tabla.get(this.logico(tenantId))!;
    return r.estado === 'DOBLE_ESCRITURA' || r.estado === 'VERIFICANDO'
      ? [r.shardFisico, r.destino!]        // los dos
      : [r.shardFisico];
  }

  /** De dónde leer. Siempre de UNO: la fuente de verdad. */
  paraLectura(tenantId: string): string {
    const r = this.tabla.get(this.logico(tenantId))!;
    return r.estado === 'CAMBIANDO' ? r.destino! : r.shardFisico;
  }
}
```

**El paso de `% 4` a `% 1024` no mueve datos.** Es un cambio puramente de
código: `ruteo[i] = 'pg-shard-' + (i % 4)` reproduce exactamente el mapeo
actual. Se deploya, se verifica que nada cambió, y ahí recién empieza la
migración real. **Es la fase más importante y la que no se nota.**

### 4.2 Las seis fases, por shard lógico

```
┌─ FASE 1 — PREPARAR ───────────────────────────────────────────────┐
│ Levantar shard-5 y shard-6 vacíos, con el mismo esquema.         │
│ estado = ESTABLE. Nada cambió todavía.                           │
└───────────────────────────────────────────────────────────────────┘
┌─ FASE 2 — DOBLE ESCRITURA ────────────────────────────────────────┐
│ estado = DOBLE_ESCRITURA, destino = 'pg-shard-5'                 │
│ Toda escritura del shard lógico 7 va al 1 Y al 5.                │
│ Las lecturas siguen yendo al 1.                                  │
│                                                                   │
│ >>> DESDE ACÁ NO SE PIERDE NADA DE LO QUE LLEGUE DURANTE LA      │
│     COPIA. Es exactamente el problema que resuelve esta fase.    │
└───────────────────────────────────────────────────────────────────┘
┌─ FASE 3 — BACKFILL ───────────────────────────────────────────────┐
│ Copiar lo histórico por lotes, con rate limiting.                │
│ Escribir con "no pisar si lo que hay es más nuevo", porque la    │
│ doble escritura puede haber dejado una versión más fresca.       │
└───────────────────────────────────────────────────────────────────┘
┌─ FASE 4 — VERIFICAR  ← LA FASE QUE TODOS SALTEAN ────────────────┐
│ estado = VERIFICANDO                                             │
│ Shadow reads: leer de los dos, comparar, registrar diferencias   │
│ SIN usar el resultado nuevo. Más count(*) y checksums por tabla. │
│ Hasta que la tasa de diferencias sea CERO varios días, no se     │
│ avanza.                                                          │
└───────────────────────────────────────────────────────────────────┘
┌─ FASE 5 — CAMBIAR LAS LECTURAS ──────────────────────────────────┐
│ estado = CAMBIANDO. Las lecturas van al 5.                       │
│ Es un UPDATE de una fila: revertir tarda un segundo.             │
└───────────────────────────────────────────────────────────────────┘
┌─ FASE 6 — CONTRACT ───────────────────────────────────────────────┐
│ estado = ESTABLE, shard_fisico = 'pg-shard-5', destino = NULL     │
│ Apagar la doble escritura. Borrar los datos del shard 1          │
│ DESPUÉS de un backup y una semana de gracia.                     │
└───────────────────────────────────────────────────────────────────┘
```

### 4.3 La doble escritura

```ts
@Injectable()
export class TenantRepository {
  async guardar(tenantId: string, entidad: Orden): Promise<Orden> {
    const destinos = this.router.paraEscritura(tenantId);
    const [primario, ...secundarios] = destinos;

    // El PRIMARIO es la fuente de verdad: si falla, la operación falla
    const resultado = await this.ds(primario).getRepository(Orden).save(entidad);

    // Los SECUNDARIOS no pueden tumbar la operación: van por cola
    for (const s of secundarios) {
      await this.outbox.encolar({
        topic: 'shard.replicar',
        payload: { shard: s, tabla: 'ordenes', fila: resultado },
        dedupKey: `${s}:ordenes:${resultado.id}:${resultado.version}`,
      });
    }
    return resultado;
  }
}
```

**Por qué la escritura secundaria va por cola y no sincrónica:** si fuera
sincrónica, un shard nuevo lento o caído **tumbaría las escrituras de
producción** — convertirías un shard que todavía no sirve a nadie en una
dependencia crítica (el problema de disponibilidad compuesta del
[módulo 02](../modules/02-comunicacion-servicios/README.md)).

Y por **outbox** y no `emit()` directo: si el proceso muere entre el `save` y
el encolado, esa escritura **no llegaría nunca** al shard nuevo y la
verificación de la fase 4 encontraría una diferencia que nadie sabría explicar
([caso 01](01-outbox-el-evento-que-nunca-salio.md)).

### 4.4 El backfill por lotes

```ts
async backfill(shardLogico: number, origen: string, destino: string) {
  const TAMANO_LOTE = 2_000;
  let cursor = '0';

  while (true) {
    const filas = await this.ds(origen).query(`
      SELECT * FROM ordenes
      WHERE (hashtext(tenant_id) & 1023) = $1
        AND id > $2
      ORDER BY id
      LIMIT $3
    `, [shardLogico, cursor, TAMANO_LOTE]);

    if (filas.length === 0) break;

    // "No pisar si lo que hay es más nuevo": la doble escritura ya pudo
    // haber puesto una versión posterior a la del snapshot.
    await this.ds(destino).query(`
      INSERT INTO ordenes SELECT * FROM json_populate_recordset(NULL::ordenes, $1)
      ON CONFLICT (id) DO UPDATE
        SET ... WHERE ordenes.version < EXCLUDED.version
    `, [JSON.stringify(filas)]);

    cursor = filas[filas.length - 1].id;
    await this.esperarSegunCarga(origen);     // rate limiting adaptativo
  }
}
```

```ts
/** No drenar a máxima velocidad: es el error del módulo 04 y del 07, D1. */
private async esperarSegunCarga(shard: string) {
  const qps = await this.metricas.qpsDe(shard);
  const capacidad = this.capacidades[shard];
  if (qps > capacidad * 0.7) await sleep(500);        // frená
  else await sleep(50);
}
```

### 4.5 La verificación — la fase que todos saltean

```ts
/** Shadow reads: leer de los dos, comparar, NO usar el nuevo. */
async leerConSombra(tenantId: string, id: string) {
  const r = this.router.ruta(tenantId);
  const real = await this.ds(r.shardFisico).findOne(id);

  if (r.estado === 'VERIFICANDO') {
    // Fuera del camino crítico: si falla, no afecta al usuario
    setImmediate(async () => {
      try {
        const sombra = await this.ds(r.destino!).findOne(id);
        if (!deepEqual(real, sombra)) {
          this.metricas.increment('shard.diferencia', { shard: r.shardLogico });
          this.logger.error({ tenantId, id, real, sombra }, 'DIFERENCIA');
        }
      } catch (e) { this.metricas.increment('shard.sombra_error'); }
    });
  }
  return real;      // ← siempre se devuelve el de la fuente de verdad
}
```

```sql
-- Y la verificación masiva, que corre en paralelo a los shadow reads
SELECT count(*), sum(hashtext(id || version::text)) AS checksum
FROM ordenes WHERE (hashtext(tenant_id) & 1023) = $1;
-- Tiene que dar lo mismo en los dos shards.
```

**Criterio para avanzar a la fase 5:** cero diferencias durante **tres días**
con tráfico real, y checksums idénticos. No "lo probamos y anduvo".

### 4.6 El orquestador

```ts
@Injectable()
export class MigracionOrquestador {
  /** Mueve UN shard lógico, de punta a punta, con reversión posible. */
  async moverShard(logico: number, destino: string) {
    const r = await this.meta.obtener(logico);

    await this.meta.setEstado(logico, 'DOBLE_ESCRITURA', destino);
    await this.esperarPropagacionDelRouter();        // ~2 s: todos los pods

    await this.backfill(logico, r.shardFisico, destino);

    await this.meta.setEstado(logico, 'VERIFICANDO', destino);
    const ok = await this.verificarDurante({ dias: 3, diferenciasMax: 0 });
    if (!ok) {
      await this.meta.setEstado(logico, 'ESTABLE');   // ← REVERSIÓN: nada se perdió
      throw new MigracionAbortadaError(logico);
    }

    await this.meta.setEstado(logico, 'CAMBIANDO', destino);
    await this.observarDurante({ horas: 24 });

    await this.meta.promover(logico, destino);        // ESTABLE en el destino
  }
}
```

**Y el orden en que se mueven los 341 shards importa:**

```
1. Uno solo, el que tenga el tenant más chico. Observar 48 h.
2. Diez, de tenants chicos. Observar 24 h.
3. Cincuenta por día, mientras las métricas estén limpias.
4. Los tenants grandes AL FINAL, de a uno, con aviso previo.
```

## 5. Por qué así y no de otra forma

### ❌ "Cambiamos `% 4` por `% 6` y deployamos"

Es la operación que parece de una línea y es **la que destruye datos**. El 67%
de los tenants ve su cuenta vacía, empieza a escribir en el shard nuevo, y a
los dos minutos sus datos están **partidos entre dos shards sin que ninguno
tenga la verdad completa**. Revertir pierde las escrituras nuevas; no revertir
pierde las viejas.

**No hay vuelta atrás de esto.** Es el único error de todo el repo del que no
se sale con un rollback.

### ❌ "Ventana de mantenimiento el domingo a la madrugada"

Copiar 7,4 TB sin matar las bases son **18-30 horas**. No entra en una
ventana, y un SaaS B2B con clientes en tres continentes ya no tiene ventanas
reales.

Y aunque entrara: una migración de 20 horas **sin posibilidad de verificar
gradualmente** es apostar el negocio a que no haya ni un bug en el copiador.
La fase 4 existe justamente porque siempre hay uno.

### ❌ "Copiamos en caliente y cambiamos el flag al final"

Es la trampa más seductora, porque parece el plan correcto. Y le falta **la
fase 2**: las escrituras que llegan **durante** las 20 horas de copia van al
shard viejo, y el nuevo nace desactualizado por una cantidad que no se puede
determinar.

> **La doble escritura no es un paso opcional del plan: es la respuesta a la
> pregunta "¿qué pasa con las escrituras que ocurren durante la copia?".** Sin
> ella, no hay plan.

La alternativa válida a la doble escritura es **CDC**: snapshot + aplicar el
stream de cambios desde el LSN del snapshot con Debezium. Menos código en la
aplicación, más infraestructura, y el riesgo del slot de replicación que llena
el disco ([caso 01, §5](01-outbox-el-evento-que-nunca-salio.md)). Si ya tenés
Debezium, es la mejor opción.

### ❌ "Consistent hashing a nivel de fila"

Baja el movimiento del 67% al 33% y **no cambia la naturaleza del problema**:
seguís moviendo claves individuales, no podés enumerar qué se mueve, y
**no podés revertir a mitad**. Es una mejora cuantitativa cuando lo que hace
falta es cualitativa.

**Los shards lógicos convierten "mover 7,4 TB de datos" en "mover 341
unidades"**, y eso es lo que hace la operación posible: verificable, reversible
y con radio de daño del 0,1%.

### ❌ "Una instancia más grande y listo"

**Escalar vertical es la respuesta correcta hasta que se agota**, y acá ya se
agotó: *"no hay instancia más grande disponible en esa familia"*. Si la
hubiera, sería la opción correcta — una tarde de trabajo contra dos
trimestres.

El error es el opuesto: shardear **antes** de agotar vertical. Por eso el
[módulo 03, D2](../modules/03-escalabilidad/respuestas.md) pone sharding como
la **última** herramienta, después de índices, pooling, caché, réplicas,
particionado por tiempo y archivado.

### ❌ "Multiplicamos los shards por 2 para que el mapeo sea más fácil"

De 4 a 8, con `% 8`, sólo se mueve el 50% (las claves con `hash % 8 < 4` se
quedan). **Es cierto, y es la solución más común en la práctica** porque el
movimiento es predecible: cada shard viejo se parte exactamente en dos.

Sus límites: **te obliga a duplicar siempre** (4 → 8 → 16), lo que puede ser
mucho más capacidad de la que necesitás y pagás; sigue siendo 5,5 TB de
movimiento; y **no te da reversibilidad por unidad**.

Si no tenés shards lógicos y hay que mover ya, es la mejor opción táctica. No
reemplaza arreglar el mapeo.

### ❌ Saltear la fase 4

Es lo que pasa cuando la migración se atrasa y hay presión. Y las diferencias
que aparecen son **siempre** de una de estas tres clases, todas silenciosas:

1. Filas que el copiador salteó por un bug de paginación (un `id` duplicado,
   un cursor mal avanzado).
2. Escrituras que llegaron en la ventana entre el snapshot y la doble
   escritura.
3. Columnas con `DEFAULT now()` o triggers que generaron **valores distintos**
   en el destino.

Ninguna produce un error. Las tres se descubren meses después, cuando un
cliente pregunta por una factura que no está.

### ❌ "El router en memoria de cada pod, sin tabla central"

Si el mapeo vive en una constante del código, cambiar una fase requiere **un
deploy** — y durante el rolling update **hay pods con mapeos distintos
escribiendo al mismo tiempo**. Con 341 shards a mover, son 341 deploys y 341
oportunidades de inconsistencia.

La tabla central con refresco de 1 s hace que un cambio de fase sea **un
`UPDATE` que se propaga en segundos**, igual para todos. Y revertir es otro
`UPDATE`.

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Umbral para avanzar |
| --- | --- | --- |
| **`shard.diferencia`** por shard lógico | Shadow reads que no coinciden | **0 durante 3 días** |
| **`count(*)` y checksum** por tabla y shard | Verificación masiva | **Idénticos** |
| **Lag de la cola de replicación** | Qué tan atrás está el shard nuevo | **< 5 s** |
| **QPS y p99 del shard ORIGEN** | Que el backfill no esté matando producción | **< 70% de capacidad** |
| **Errores de escritura secundaria** | Escrituras que no llegaron al destino | **0** (y van a DLQ si fallan) |
| **Shards lógicos por estado** | Dónde está la migración | Dashboard |

Y la alerta que importa durante toda la migración:

```sql
-- Shards lógicos trabados en un estado intermedio: una migración que se colgó
SELECT shard_logico, estado, now() - actualizado AS hace
FROM shard_routing
WHERE estado <> 'ESTABLE' AND actualizado < now() - interval '7 days';
```

**Cómo lo testeás — y acá está el valor, porque todo esto se puede probar
antes:**

```ts
it('el shard lógico de un tenant NUNCA cambia', () => {
  // Es el contrato de todo el diseño: si esto cambia, se rompe todo
  expect(router.logico('acme')).toBe(723);
  expect(router.logico('acme')).toBe(hash('acme') % 1024);
});

it('la tabla de ruteo inicial reproduce EXACTAMENTE el mapeo de % 4', () => {
  // La fase 0 no debe mover ni un tenant
  for (const t of tenantsDeProduccion) {
    expect(router.paraLectura(t)).toBe(`pg-shard-${hash(t) % 4}`);
  }
});

it('en DOBLE_ESCRITURA escribe en los dos y lee del viejo', async () => {
  await meta.setEstado(723, 'DOBLE_ESCRITURA', 'pg-shard-5');
  await repo.guardar('acme', orden);
  expect(await ds('pg-shard-1').findOne(orden.id)).toBeDefined();
  expect(await ds('pg-shard-5').findOne(orden.id)).toBeDefined();   // por la cola
  expect(router.paraLectura('acme')).toBe('pg-shard-1');            // sigue el viejo
});

it('el backfill no pisa una versión más nueva de la doble escritura', async () => {
  await ds('pg-shard-5').save({ id: 'o1', version: 7, total: 500 });  // la nueva
  await backfill.copiarFila({ id: 'o1', version: 3, total: 100 });     // la del snapshot
  expect((await ds('pg-shard-5').findOne('o1')).version).toBe(7);      // ganó la nueva
});

it('revertir desde VERIFICANDO deja todo como estaba', async () => {
  const antes = await snapshotDe('pg-shard-1');
  await orquestador.moverShard(723, 'pg-shard-5').catch(() => {});
  await meta.setEstado(723, 'ESTABLE');
  expect(await snapshotDe('pg-shard-1')).toEqual(antes);
  expect(router.paraLectura('acme')).toBe('pg-shard-1');
});
```

Los dos primeros son **tests de contrato** y van a CI para siempre: el día que
alguien cambie el `% 1024` "para simplificar", el build falla.

**Y el ensayo completo en staging**, con un volumen de datos realista y
tráfico sintético, migrando 10 shards lógicos de punta a punta **incluyendo
una reversión deliberada**. Es la única forma de saber que el runbook funciona
antes de usarlo con datos de clientes.

## 7. El costo

1. **Dos trimestres de trabajo**, no un sprint. Y la mayor parte no es el
   copiador: es la capa de ruteo, la doble escritura y la verificación.
2. **La capa de ruteo queda para siempre.** Un lookup más (cacheado) en cada
   operación, y una base de metadatos que es **crítica**: si se cae, no sabés
   dónde está nada. Necesita réplicas y su propio monitoreo.
3. **El código de doble escritura es temporal y hay que borrarlo.** Si queda,
   en dos años nadie sabe para qué está y alguien lo "optimiza".
4. **El backfill compite con producción.** Incluso con rate limiting, la
   migración de 341 shards tarda semanas porque va despacio **a propósito**.
5. **Lo que se pierde para siempre al shardear**: joins entre shards,
   transacciones que crucen shards, `COUNT(*)` global y unicidad global. Eso
   ya estaba pagado en este caso (hace tres años), pero es el costo real de
   la decisión original.
6. **1024 shards lógicos tienen overhead**: la tabla de ruteo, y si algún día
   llegás a 1024 shards físicos, no podés crecer más sin repetir todo esto.
   (Con 1024 y shards de ~3 TB, el techo son ~3 PB: suficiente.)

**Y la decisión que habría hecho innecesario todo este caso es gratis:**
elegir muchos más shards lógicos de los necesarios **el día que shardeás por
primera vez**. Es una línea de código al principio y dos trimestres después —
exactamente como la clave de partición de Kafka
([caso 04](04-kafka-particion-caliente.md)) y como la PK de una tabla
([módulo 03, B4](../modules/03-escalabilidad/respuestas.md)).

> **Si sólo te llevás una cosa de este caso: el día que shardees, usá 1024
> shards lógicos y una tabla de ruteo. No cuesta nada y te ahorra esto.**

---

## Fuentes

- **Vitess**, *Resharding* — el procedimiento de referencia, en producción en
  YouTube y Slack: <https://vitess.io/docs/reference/vreplication/reshard/>
- **Citus**, *Shard rebalancing*:
  <https://docs.citusdata.com/en/stable/admin_guide/cluster_management.html>
- **Slack**, *Scaling Datastores at Slack with Vitess*:
  <https://slack.engineering/scaling-datastores-at-slack-with-vitess/>
- **Figma**, *How Figma's databases team lived to tell the scale* — una
  migración de sharding documentada paso a paso, con los problemas reales:
  <https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/>
- **Notion**, *Herding elephants: lessons learned from sharding Postgres*:
  <https://www.notion.so/blog/sharding-postgres-at-notion>

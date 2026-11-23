# Caso 04 — El tenant que rompió el pipeline

> **Módulos:** [07 (Kafka)](../modules/07-kafka/) ·
> [03 (escalabilidad)](../modules/03-escalabilidad/)
> **Patrón:** Clave de partición por granularidad de negocio + sub-particionado

---

## 1. El escenario

Plataforma SaaS multi-tenant. Cada acción de cada tenant produce un evento en
Kafka; un consumer group lo procesa y actualiza proyecciones.

```
topic "activity"   12 particiones
1.000 msg/s en total
80 ms por mensaje  ->  12,5 msg/s por consumidor  ->  150 msg/s de capacidad total
12 consumidores, uno por partición
key = tenantId          <- "para tener orden por tenant"
```

Durante dos años funcionó perfecto: 400 tenants, el más grande con el 4% del
tráfico, el lag en cero.

Después entró un cliente enterprise. **Solo, concentra el 40% del tráfico.**

## 2. Qué se rompe

**El síntoma:** el lag empieza a crecer. El equipo escala el deployment del
consumer de 12 a 48 réplicas. **El lag no baja nada.** Alguien agrega
particiones: de 12 a 96. **El lag sigue creciendo.**

Y lo que hace que el diagnóstico sea tan difícil:

- La **CPU de los pods está baja**. Hay capacidad de sobra.
- El **lag total del grupo se ve casi normal**: una partición con lag creciente
  entre 95 vacías se diluye en el promedio.
- **Ningún dashboard está rojo.**
- Los otros 400 tenants funcionan perfecto. **Sólo el cliente más importante
  ve datos de hace 40 minutos.**

**La causa.** `key = tenantId` significa
`partición = murmur2(tenantId) % numParticiones`. Para el mega-tenant, eso da
**un** número. **Todos sus eventos entran por una sola puerta**, y esa puerta
la atiende **un solo consumidor**
([módulo 07, §3](../modules/07-kafka/README.md)).

Los números de [`claves.ts`](../modules/07-kafka/claves.ts):

```
estrategia                  part. más cargada   su carga    lag tras 1 h
key = tenantId                         42.9 %   429 msg/s     1.183.831  💀
key = orderId                           8.5 %    85 msg/s             0  ✅
```

429 msg/s entrando a una partición cuyo consumidor puede con 12,5. El lag
crece **416 mensajes por segundo, para siempre.**

**Y por qué agregar particiones no sirvió:**

```
particiones   part. más cargada   capacidad total del grupo
         12               42.9 %       1.200 msg/s   💀
         96               40.5 %       9.600 msg/s   💀
        200               40.1 %      20.000 msg/s   💀
```

Pasar de 12 a 200 particiones **multiplica por 17 la capacidad del grupo** y
la partición caliente **sigue recibiendo el 40%**, porque
`murmur2("tenant-x") % 200` sigue dando un número.

> **Agregar particiones nunca arregla una partición caliente. Lo único que la
> arregla es cambiar la clave.**

Peor: aumentar particiones **cambió el mapeo `key → partición`** de **todos**
los tenants, así que durante la transición se rompió el orden entre los
eventos viejos y nuevos de cada clave — justamente la garantía por la que se
había elegido `tenantId`. Se pagó el costo y no se obtuvo el beneficio.

## 3. La solución probada

La pregunta que resuelve el caso no es técnica:

> **¿De verdad necesitás orden entre dos acciones distintas del mismo tenant?**

Casi nunca. Lo que el negocio necesita es orden **por entidad**: los eventos de
*una orden*, de *un documento*, de *una conversación*. Que la orden A y la
orden B del mismo tenant se procesen desordenadas entre sí **no le importa a
nadie**.

> **Usá la granularidad más fina que preserve el orden que el negocio
> necesita.** Una clave más gruesa te da un orden que no usás y una partición
> caliente que sí sufrís.

Y si de verdad necesitás orden por tenant (saldos de una cuenta, un stream de
auditoría que tiene que ser secuencial), el patrón es **sub-particionar la
clave en buckets** — lo que hacen LinkedIn y Uber para claves desparejas.

## 4. La implementación

### 4.1 El arreglo principal: cambiar la clave

```ts
// ❌ ANTES: orden por tenant, que nadie usa, y una partición caliente
await this.producer.send({
  topic: 'activity',
  messages: [{ key: ev.tenantId, value: JSON.stringify(ev) }],
});

// ✅ DESPUÉS: orden por la entidad que de verdad lo necesita
await this.producer.send({
  topic: 'activity',
  messages: [{ key: ev.entityId, value: JSON.stringify(ev) }],
});
```

Una línea. Lleva la partición más cargada del 42,9% al 8,5%.

**Pero no se puede cambiar en caliente sin pensarlo**, porque durante la
transición conviven mensajes con las dos claves y el orden por entidad no está
garantizado entre lo viejo y lo nuevo. El procedimiento seguro es el de
*expand / migrate / contract*
([módulo 02](../modules/02-comunicacion-servicios/README.md)):

```
1. TOPIC NUEVO con la cantidad correcta de particiones y la clave nueva.
   (En vez de mutar el existente: el mapeo viejo queda intacto.)

2. DOBLE ESCRITURA: el productor publica en los dos topics.

3. CONSUMER NUEVO sobre el topic nuevo, escribiendo en una proyección
   NUEVA. Shadow: todavía nadie la lee.

4. VERIFICAR: comparar las dos proyecciones hasta que la diferencia sea
   cero durante varios días.

5. CAMBIAR LAS LECTURAS a la proyección nueva, con feature flag y por
   porcentaje.

6. CONTRACT: apagar la doble escritura, borrar el topic viejo.
```

### 4.2 Si de verdad necesitás orden por tenant: buckets

```ts
const BUCKETS_POR_TENANT = 16;

/**
 * Sub-particiona un tenant en N buckets.
 *
 * CLAVE: el bucket se elige con un hash ESTABLE de la entidad, nunca al azar.
 * Si fuera random, dos eventos de la misma entidad caerían en buckets
 * distintos y perderías el orden que vinimos a preservar.
 */
function claveDeParticion(ev: ActivityEvent): string {
  if (!TENANTS_GRANDES.has(ev.tenantId)) return ev.tenantId;   // el 99,8% sin cambios

  const bucket = murmur2(ev.entityId) % BUCKETS_POR_TENANT;
  return `${ev.tenantId}:${bucket}`;
}
```

Esto te da **orden dentro del bucket** (o sea: orden por entidad, porque una
entidad siempre cae en el mismo bucket) y reparte la carga del mega-tenant
entre 16 particiones.

**El trade-off explícito:** perdés el orden **entre entidades distintas del
mismo tenant**. Si tu dominio tolera eso —y casi siempre lo tolera— es la
solución correcta. Si no lo tolera, no hay forma de paralelizar: el orden
total y el paralelismo son incompatibles.

```ts
// Y la lista de tenants grandes NO se hardcodea: se calcula
@Cron('0 * * * *')
async recalcularTenantsGrandes() {
  const grandes = await this.metricas.query(`
    topk(10, sum by (tenant) (rate(activity_events_total[1h])))
  `);
  const total = await this.metricas.query(`sum(rate(activity_events_total[1h]))`);

  // Umbral: más del 5% del tráfico total justifica sub-particionar
  const nuevos = grandes.filter((t) => t.valor / total > 0.05).map((t) => t.tenant);
  await this.config.set('tenants_subparticionados', nuevos);
}
```

Ese cron es la diferencia entre resolver **este** incidente y resolver **la
clase** de incidente: el próximo cliente enterprise se sub-particiona solo.

### 4.3 La alternativa para un tenant verdaderamente enorme: topic dedicado

```ts
function topicDe(ev: ActivityEvent): string {
  return TENANTS_DEDICADOS.has(ev.tenantId)
    ? `activity.${ev.tenantId}`     // su propio topic, sus propias particiones
    : 'activity';
}
```

Feo, y a veces es lo correcto: le da al tenant **aislamiento total**
(su propio consumer group, su propio escalado, su propio lag) y evita que un
pico suyo afecte a los otros 400. Es un *bulkhead*
([módulo 08, §5](../modules/08-fiabilidad/README.md)) aplicado a topics.

El costo: más topics que operar, y la lógica de ruteo en el productor.

### 4.4 El dimensionamiento correcto de particiones

```
particiones >= throughput pico / throughput por consumidor
            = 1.000 msg/s / 12,5 msg/s
            = 80  ->  con margen 2-3x: 192 particiones
```

Y **192, no 200**: muchos divisores (2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64,
96) para que el reparto entre consumidores quede parejo con casi cualquier
cantidad de pods. Con 200 particiones y 7 consumidores, uno toma 29 y los
otros 28: desbalance permanente y gratuito.

### 4.5 La otra palanca, que casi nadie prueba primero

```ts
// ANTES: 80 ms por mensaje
async handle(ev: ActivityEvent) {
  const entidad = await this.repo.findOne(ev.entityId);        // 15 ms
  await this.enriquecedor.consultarPerfil(ev.userId);          // 45 ms  ← HTTP sincrónico
  await this.repo.save({ ...entidad, ...cambios });            // 20 ms
}

// DESPUÉS: ~18 ms por mensaje
async handleBatch(evs: ActivityEvent[]) {
  const entidades = await this.repo.findByIds(evs.map((e) => e.entityId));   // 1 query
  const perfiles  = await this.cachePerfiles.getMany(evs.map((e) => e.userId)); // caché local
  await this.repo.save(evs.map((e) => proyectar(e, entidades, perfiles)));   // 1 insert masivo
}
```

De 80 ms a 18 ms **cuadruplica el throughput por consumidor sin tocar la
topología del topic ni perder ninguna garantía**. En este caso concreto, llevar
el procesamiento a 18 ms sube la capacidad por partición de 12,5 a 55 msg/s —
que ya absorbe los 429 del mega-tenant con 8 particiones de margen.

**Es la palanca más barata y la última que se prueba.** Siempre.

## 5. Por qué así y no de otra forma

### ❌ "Agregamos más consumidores"

Es lo primero que hace todo el mundo y **no cambia nada**: en un consumer
group, cada partición la consume **exactamente un** consumidor. Con 12
particiones y 48 réplicas, **36 pods están vivos, sanos, pasando health
checks, consumiendo CPU y memoria, y sin recibir un solo mensaje**.

Y hay una trampa encima: **los pods idle no consumen CPU**, así que bajan el
promedio del deployment y **el HPA sigue escalando**. Terminás con 48 pods, el
throughput de 12, y un autoescalado convencido de estar trabajando
([módulo 07, B1](../modules/07-kafka/respuestas.md)).

### ❌ "Agregamos más particiones"

Multiplica la capacidad del grupo y **no toca el problema**, porque la clave
caliente sigue cayendo en una sola partición. Los números están arriba: de 12
a 200 particiones, la partición más cargada pasa del 42,9% al 40,1%.

Y encima **cuesta**: las particiones no se pueden reducir nunca, y aumentarlas
cambia el mapeo de **todas** las claves, rompiendo el orden por clave durante
la transición. **Pagás el costo completo sin obtener el beneficio.**

### ❌ "Usamos `key = null` y chau"

Resuelve el reparto perfectamente (8,3% en la partición más cargada) y **tira
el orden a la basura**. `activity.updated` puede llegar antes que
`activity.created`, y tu proyección queda inconsistente de formas que no vas a
poder reproducir. Si tu consumidor es idempotente **y** conmutativo (el orden
no afecta el resultado final), es una opción legítima. Casi nunca lo es.

### ❌ "Concurrencia dentro del consumidor"

Procesar el batch de una partición en paralelo multiplica el throughput sin
tocar el topic. Y tiene dos costos serios:

1. **Perdés el orden dentro de la partición**, que es lo único que Kafka te
   garantizaba. Si elegiste una clave *para tener orden*, esto lo anula.
2. **El manejo de offsets se vuelve delicado**: no podés commitear el offset N
   hasta que **todo** lo anterior terminó, o perdés mensajes en el próximo
   rebalance.

Sólo vale si el procesamiento es idempotente y sin orden — y en ese caso,
`key = null` es más simple.

### ❌ "Le pedimos al cliente enterprise que mande menos tráfico"

Aparece en toda reunión y no es una solución técnica ni comercial: es el
cliente que más paga. El sistema tiene que absorberlo.

### ⚠️ Topic dedicado: cuándo sí

No es la primera opción porque multiplica los topics y mete lógica de ruteo en
el productor. **Es la opción correcta cuando el tenant es tan grande que
querés aislarlo del todo**: SLA propio, escalado propio, y que un pico suyo no
afecte a los otros 400. A partir de cierto tamaño, un cliente dedicado es una
decisión de producto, no de arquitectura.

## 6. Cómo sabés que funciona

**La métrica que hay que tener, y es la única que muestra el problema:**

```promql
# Lag POR PARTICIÓN, no el total del grupo
max by (partition) (kafka_consumergroup_lag{group="activity-processor"})
```

Alerta: *"alguna partición con lag creciente durante 5 minutos"*. **El lag
total promediado esconde el caso**: una partición rota entre 95 sanas no mueve
el agregado.

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **Lag máximo por partición** | El problema de este caso | Creciendo 5 min |
| **Desbalance** = max/mediana de mensajes por partición | La clave está mal elegida | **> 3x** |
| **Consumidores idle** = `réplicas − particiones` | Pods tirados a la basura | **> 0** |
| **Distribución de tráfico por tenant** | Cuándo entra el próximo enterprise | **Un tenant > 5%** |
| **p99 del handler** | Si sube, el techo por consumidor baja | Regresión semana a semana |

La cuarta es la **preventiva**: te avisa **antes** de que el próximo cliente
grande rompa el pipeline, no después.

**Cómo lo testeás.** Esto no se testea con un unit test: se testea
**midiendo la distribución** de la función de particionado.

```ts
it('ningún tenant concentra más del 15% de una partición', () => {
  const PARTICIONES = 192;
  const cuenta = new Array(PARTICIONES).fill(0);

  // Tráfico realista: un mega-tenant al 40% + cola Zipf
  for (const ev of generarTraficoRealista(500_000)) {
    cuenta[murmur2(claveDeParticion(ev)) % PARTICIONES]++;
  }

  const total = cuenta.reduce((a, b) => a + b, 0);
  const peor = Math.max(...cuenta) / total;
  expect(peor).toBeLessThan(0.15 / (PARTICIONES / 12));   // margen sobre el ideal
});

it('dos eventos de la misma entidad van SIEMPRE a la misma partición', () => {
  const a = { tenantId: 'mega', entityId: 'ord-1', tipo: 'created' };
  const b = { tenantId: 'mega', entityId: 'ord-1', tipo: 'updated' };
  expect(claveDeParticion(a)).toBe(claveDeParticion(b));   // ← el orden que importa
});
```

El segundo test es el que impide que alguien "arregle" el desbalance usando un
bucket aleatorio y rompa el orden en silencio. **Es el test que protege la
garantía, no la performance.**

## 7. El costo

1. **Perdés el orden por tenant.** Si alguna parte del sistema lo asumía sin
   que nadie lo haya escrito, se rompe. Hay que auditar los consumidores antes.
2. **La migración es un topic nuevo + doble escritura + verificación**: semanas
   de trabajo, no un deploy. El cambio de clave es de una línea; cambiarlo con
   seguridad no.
3. **El sub-particionado agrega una capa de indirección** (la lista de tenants
   grandes, el cron que la calcula) que hay que mantener y entender.
4. **Más particiones = más metadata en el broker**, más archivos abiertos y
   rebalances más lentos. 192 está bien; 20.000 no.
5. **Un topic dedicado por tenant** es lógica de ruteo en el productor y N
   consumer groups que operar.

**Y la decisión más importante de todo el caso es gratis:** elegir bien la
clave **el día 1**. Es una línea de código al principio y semanas de migración
después — exactamente como la clave de partición de una base
([módulo 03, B3](../modules/03-escalabilidad/respuestas.md)).

---

## Fuentes

- **Kafka**, *Consumer groups y particiones*:
  <https://kafka.apache.org/documentation/#intro_consumers>
- **Confluent**, *How to choose the number of partitions*:
  <https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/>
- **Uber**, *Real-time exactly-once ad event processing* — sub-particionado de
  claves desparejas en producción:
  <https://www.uber.com/blog/real-time-exactly-once-ad-event-processing/>
- **LinkedIn**, *Kafka at LinkedIn: current and future* — el problema de las
  claves calientes a escala:
  <https://engineering.linkedin.com/kafka/running-kafka-scale>

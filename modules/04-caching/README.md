# Módulo 04 — Caching

## Por qué acá

En el módulo 03, la simulación de consistent hashing terminó con un número
incómodo: cuando un nodo de caché se cae, **la base pasa de 2.500 a 35.000
req/s de golpe**. Ese número resume el módulo entero:

> **Un caché no es una optimización. Es una dependencia estructural que,
> cuando falla, se lleva puesto todo lo que estaba protegiendo.**

Casi todo el mundo sabe poner un `SET` y un `GET` en Redis. Lo que se pregunta
en entrevistas —y lo que rompe producción— es lo otro: qué pasa cuando expira,
cuando se cae, cuando la clave está caliente, y cómo sabés que lo que
devolvés no es mentira.

## Teoría mínima

### 1. Por qué funciona: localidad

Los accesos a datos **no son uniformes**: siguen una distribución de Zipf
(la ley de potencias). El artículo más popular recibe el doble de visitas que
el segundo, el triple que el tercero. En la práctica:

> **El 20% de los datos recibe el 80% de las lecturas.** Y muchas veces es más
> extremo: el 1% recibe el 50%.

Por eso un caché chico da un hit rate altísimo: no necesitás guardar todo,
necesitás guardar **lo caliente**. Dimensionar el caché es, básicamente,
estimar ese 20%.

### 2. La matemática del hit rate (y por qué es no lineal)

La latencia efectiva es una media ponderada:

```
L_efectiva = hit_rate × L_cache + (1 - hit_rate) × L_origen
```

Con Redis en 1 ms y Postgres en 50 ms:

| Hit rate | Latencia efectiva | Carga a la base |
| --- | --- | --- |
| 0% | 50,0 ms | 100% |
| 50% | 25,5 ms | 50% |
| 90% | 5,9 ms | 10% |
| 95% | 3,5 ms | **5%** |
| 99% | 1,5 ms | **1%** |

Lo que hay que ver acá **no es la latencia: es la última columna.** Subir el
hit rate de 90% a 95% baja la latencia un 40%... pero **baja la carga de la
base a la mitad**. Y de 95% a 99% la baja **5 veces más**.

Ese es el verdadero valor de un caché: no es que las lecturas sean rápidas,
es **cuántas lecturas nunca llegan a la base**. Y por eso el mismo cálculo
leído al revés da miedo: **si el hit rate cae de 99% a 90%, la base recibe
10x el tráfico.** No hace falta que el caché se caiga; alcanza con que
empeore.

### 3. Dónde cachear: es una pila, no un lugar

| Capa | Latencia | Alcance | Invalidar |
| --- | --- | --- | --- |
| Browser (`Cache-Control`) | 0 ms | 1 usuario | ❌ Imposible: ya está en su máquina |
| **CDN / edge** | 10-30 ms | Global | Purge por API (segundos) |
| Caché local en el pod (`Map`, LRU) | 0,01 ms | 1 pod | Difícil: N pods, N copias |
| **Redis** | 1 ms | Toda la flota | Fácil: `DEL` |
| Buffer pool de la base | 0,1 ms | La base | Automático |
| Vista materializada | — | La base | Refresh programado |

Dos reglas prácticas:

- **Cuanto más cerca del usuario, más rápido y más difícil de invalidar.** Un
  `Cache-Control: max-age=3600` mal puesto es irreversible: ya está en el
  navegador de la gente. Por eso los assets llevan hash en el nombre.
- **El caché de dos niveles (local + Redis) es muy potente y muy peligroso.**
  Te ahorra el salto de red para lo súper caliente, pero ahora tenés N copias
  locales que no se pueden invalidar de forma sincronizada. Sólo para datos
  que toleren estar desactualizados unos segundos, y con TTL local corto
  (5-30 s).

### 4. Los patrones

**Cache-aside (*lazy loading*)** — el 90% de los casos:

```ts
async getUser(id: string) {
  const cached = await this.redis.get(`user:${id}`);
  if (cached) return JSON.parse(cached);

  const user = await this.repo.findOne(id);          // miss -> a la base
  await this.redis.set(`user:${id}`, JSON.stringify(user), 'EX', 300);
  return user;
}
```

✅ Simple, sólo cachea lo que se pide, resiste caídas del caché.
❌ Cada miss paga la latencia completa; el primer acceso siempre es lento; y
tiene un *race condition* que vemos en la sección 6.

**Write-through**: escribís en el caché y en la base a la vez. Caché siempre
fresco; cada escritura paga latencia doble y cacheás cosas que nadie va a
leer.

**Write-behind (*write-back*)**: escribís en el caché y la base se actualiza
después, asincrónicamente. Escrituras muy rápidas, y **si el caché se cae
perdés datos**. Sólo para datos donde perder unos segundos es tolerable
(contadores de vistas, "me gusta", métricas).

**Refresh-ahead**: refrescás las claves calientes **antes** de que expiren.
Elimina el miss del usuario; gasta recursos en claves que quizás ya nadie
pide.

**Regla de decisión:** cache-aside por defecto. Write-through sólo si no
tolerás datos viejos **y** sabés que lo que escribís se va a leer.
Write-behind sólo si tolerás perder datos.

### 5. Invalidación

Las opciones, de peor a mejor según el caso:

1. **TTL.** Simple y robusto: el dato se muere solo. El precio es que
   **aceptás servir datos viejos hasta TTL segundos**. Casi siempre es la
   respuesta correcta, y elegir el TTL es elegir explícitamente cuánta
   desactualización tolerás.
2. **Invalidación por evento.** Cuando algo cambia, publicás un evento y los
   consumidores hacen `DEL`. Es preciso, y es donde aparecen los bugs sutiles
   (¿y si el evento se pierde? ¿y si llega antes que la escritura?).
3. **Versionado de claves.** En vez de borrar, cambiás la clave:
   `user:123:v7`. **Nunca hay una clave inválida** — las viejas simplemente
   dejan de pedirse y expiran solas. Elimina toda una clase de race
   conditions, a costa de ocupar memoria con basura un rato.
4. **Namespace con versión global.** `cache:v12:user:123`. Bumpeás `v12` a
   `v13` en un deploy y **invalidás todo el caché de una** sin recorrer
   claves. Imprescindible cuando cambiás el formato de lo que serializás.

Y el error clásico: **`KEYS *` en producción**. Bloquea Redis, que es
single-threaded, durante todo el recorrido. Si necesitás recorrer, `SCAN`.
Si necesitás borrar por patrón seguido, tu esquema de claves está mal
diseñado — usá versionado.

### 6. Los cinco modos de falla

**a) Cache stampede (*dogpile*).** Una clave caliente expira. En ese
milisegundo, 5.000 requests hacen miss **a la vez** y las 5.000 van a la base
a ejecutar la misma query. La base se cae. Cuando se recupera, todos
reintentan. Es la falla más común y la que se pregunta siempre.

*Defensas:* **single-flight** (sólo una request va a la base, las demás
esperan su resultado), **TTL con jitter** (que las claves no expiren todas
juntas), **stale-while-revalidate** (servís lo viejo mientras uno refresca en
background), **expiración probabilística temprana** (cada request tiene una
probabilidad creciente de refrescar antes del vencimiento).

**b) Thundering herd al arrancar.** Deployás y todos los pods arrancan con el
caché local vacío. O se cae Redis y vuelve. Todo el tráfico va a la base de
golpe. *Defensa:* arranque escalonado, precalentamiento, y consistent hashing
para que la pérdida sea parcial.

**c) Hot key.** Una sola clave —el producto en promoción, el tenant grande—
recibe el 40% del tráfico. **Un solo nodo de Redis se satura mientras los
otros están ociosos**, y ningún sharding lo arregla porque es **una** clave.
*Defensa:* replicar la clave en N variantes (`hot:item:42:#0..#9`) y elegir
una al azar, o cachearla localmente en cada pod.

**d) Cache penetration.** Alguien pide claves que **no existen**
(`user:999999999`). No hay nada que cachear, así que **cada request va a la
base**. Con un atacante generando IDs al azar, el caché es transparente y la
base recibe el 100%. *Defensa:* **cachear el negativo** (guardar "no existe"
con TTL corto) y/o un **bloom filter** que descarte los IDs imposibles sin
tocar la base.

**e) Big key / eviction storm.** Una clave de 50 MB bloquea Redis al
serializarla. O la memoria llega al `maxmemory` y Redis empieza a evictar
masivamente, y el hit rate se desploma justo cuando más carga hay. *Defensa:*
alertar sobre `evicted_keys` y sobre el uso de memoria mucho antes del 100%.

Los modos (a), (c) y (d) están medidos en `stampede.ts`.

### 7. Políticas de evicción

Cuando la memoria se llena, hay que tirar algo:

| Política | Tira | Buena para | Mala para |
| --- | --- | --- | --- |
| **LRU** (menos usado recientemente) | Lo más viejo sin usar | Casi todo | **Scans**: un job que recorre toda la tabla desaloja lo caliente |
| **LFU** (menos frecuente) | Lo menos pedido | Tráfico muy sesgado (Zipf) | Se adapta lento a cambios de popularidad |
| **Random** | Al azar | Sorprendentemente decente, muy barato | Nada garantizado |
| **TTL más cercano** | Lo que expira antes | Cuando los TTL reflejan importancia | Ignora la popularidad |

En Redis: `maxmemory-policy`. `allkeys-lru` evicta cualquier clave;
`volatile-lru` sólo las que tienen TTL. **Si usás Redis como caché puro,
`allkeys-lru` o `allkeys-lfu`.** Si compartís la misma instancia entre caché y
datos que no se pueden perder (colas, locks, sesiones), ya empezaste mal:
separalas.

El caso que se pregunta: **un job nocturno que recorre toda la tabla te
destruye un caché LRU** (mete millones de claves que se usan una vez y
desalojan las calientes). LFU resiste eso porque cuenta frecuencia, no
recencia. Lo vas a medir en `evicciones.ts`.

### 8. Consistencia: el race de cache-aside

El bug más sutil de este módulo, y una gran pregunta de entrevista:

```
Request A (lectura)          Request B (escritura)
─────────────────────────────────────────────────
1. GET cache -> MISS
2. SELECT -> "Juan"
                             3. UPDATE -> "Pedro"
                             4. DEL cache
5. SET cache = "Juan"   <-- ¡escribe el valor VIEJO después del DEL!
```

El caché queda con "Juan" **hasta que expire el TTL**, aunque la base diga
"Pedro". Y es indetectable: no hay error, no hay log.

Las defensas:

- **TTL corto.** No lo evita, acota el daño. Es lo que hace casi todo el
  mundo, y en la mayoría de los casos alcanza.
- **Versionado de claves** (sección 5.3): si la clave incluye la versión, A
  escribe en `user:123:v7` y todos leen `user:123:v8`. El valor viejo queda
  huérfano y expira solo. **Elimina el race, no lo mitiga.**
- **Delayed double delete**: borrás, escribís en la base, esperás, borrás otra
  vez. Feo, frágil, y aun así se usa.
- **CDC**: la invalidación la dispara el log de la base (Debezium), no la
  aplicación. Correcto por construcción, y mucha más infraestructura.

La pregunta de fondo, que conviene decir explícitamente: **¿cuánto tiempo de
dato viejo tolera este caso de uso?** Si la respuesta es "cero", **no
cachees** — o cacheá con invalidación por CDC. Si es "30 segundos", un TTL
de 30 segundos resuelve el problema entero y todo lo demás es sobre-ingeniería.

### 9. Aplicado a tu stack

- **ElastiCache**: `cluster mode` reparte claves entre shards (ojo con los
  comandos multi-clave y las transacciones, que necesitan que todo esté en el
  mismo *hash slot* — se resuelve con *hash tags*: `{user:123}:profile`).
  Réplicas para lectura y failover. Y el detalle: **un failover de Redis no
  es instantáneo**, son segundos de errores.
- **Redis es single-threaded.** Un comando lento (`KEYS`, un `LRANGE` enorme,
  un script Lua pesado) **bloquea a todos los demás clientes**. `SLOWLOG` es
  tu amigo.
- **NestJS**: `CacheModule` con `cache-manager` y el store de Redis sirve para
  lo simple. El `@CacheKey`/`@CacheTTL` por decorador se queda corto apenas
  necesitás single-flight o versionado — ahí conviene un servicio propio.
- **Serialización**: `JSON.stringify` de un objeto grande **bloquea el event
  loop** (módulo 01). Cachear objetos de 5 MB en Node tiene un costo de CPU
  que no se ve en el dashboard de Redis.
- **Caché semántico para LLM** (módulo 14): las preguntas se repiten más de lo
  que uno cree. Cachear por *embedding* similar —no por texto exacto— puede
  bajar la factura de inferencia un 30-40%. Es el mismo patrón, con una
  función de igualdad distinta.

## Lo que vas a correr

```bash
node modules/04-caching/hit-rate.ts
node modules/04-caching/stampede.ts
node modules/04-caching/evicciones.ts
```

1. **`hit-rate.ts`** — la no linealidad de la sección 2, y qué pasa con la
   base cuando el hit rate se degrada un poco.
2. **`stampede.ts`** — una clave caliente que expira con 5.000 req/s encima.
   Compara TTL pelado, TTL con jitter, single-flight y
   stale-while-revalidate, midiendo el pico de QPS contra la base.
3. **`evicciones.ts`** — LRU vs LFU vs random con tráfico Zipf, y después el
   golpe: un job nocturno que recorre toda la tabla. Mirá qué le pasa al hit
   rate de cada política.

## Para pensar / próximo paso

- Tu caché tiene 99% de hit rate. Un cambio de producto hace que baje a 94%.
  ¿Cuánto más tráfico recibe la base? ¿Lo notarías antes de que se caiga?
- Cacheás el perfil del usuario con TTL de 5 minutos. El usuario cambia su
  foto y no la ve reflejada. ¿Cómo lo resolvés? Ahora, ¿y si la aplicación
  tiene 40 pods con caché local además de Redis?
- Se cae Redis por completo. ¿Tu sistema se degrada o se cae? ¿Qué número
  necesitás saber para responder eso **antes** de que pase?

## Fuentes

- **Facebook**, *Scaling Memcache at Facebook* (NSDI 2013) — stampede, leases
  y caché a escala real: <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Vattani et al.**, *Optimal Probabilistic Cache Stampede Prevention*
  (VLDB 2015) — el algoritmo XFetch: <https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf>
- **Redis**, *Key eviction policies*:
  <https://redis.io/docs/latest/develop/reference/eviction/>
- **AWS**, *Caching strategies* (ElastiCache):
  <https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html>
- **RFC 5861**, `stale-while-revalidate`:
  <https://www.rfc-editor.org/rfc/rfc5861>

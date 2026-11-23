# Caso 08 — La ampliación del caché que tiró la base

> **Módulos:** [04 (caching)](../modules/04-caching/) ·
> [03 (escalabilidad)](../modules/03-escalabilidad/)
> **Patrón:** Consistent hashing con nodos virtuales + defensas de stampede

---

## 1. El escenario

API de catálogo con un cluster de Redis como caché de lectura.

```
50.000 req/s de lectura
hit rate: 95%          -> la base recibe 2.500 req/s (los misses)
la base aguanta:          8.000 req/s antes de degradarse
4 nodos de Redis, al 85% de memoria
```

El reparto de claves es el que se escribe sin pensar:

```ts
const nodo = nodos[hash(clave) % nodos.length];
```

Los nodos se están quedando sin memoria y el hit rate empieza a bajar. La
decisión es obvia y correcta: **agregar un quinto nodo**. Se hace un martes a
las 15:00, en horario de baja carga, con todo el cuidado del mundo.

## 2. Qué se rompe

**A los 3 segundos de agregar el nodo, la base de datos se cae.**

El síntoma es desconcertante porque **la operación que lo causó era una
mejora**: se agregó capacidad de caché para aliviar la base, y la base se
murió.

**La causa.** Cambiar `nodos.length` de 4 a 5 cambia el divisor del módulo, y
eso **remapea casi todas las claves**
([`consistent-hashing.ts`](../modules/03-escalabilidad/consistent-hashing.ts)):

```
   nodos        hash % N        anillo (150 vnodos)      ideal
  4 -> 5         79.9 %              14.3 %            20.0 %
  8 -> 9         88.8 %              11.7 %            11.1 %
 16 -> 17        94.1 %               6.9 %             5.9 %
```

**El 80% de las claves pasó a vivir en otro nodo.** Y en su nodo nuevo no
están: son **misses**.

```
tráfico normal a la base:  50.000 × 0,05 = 2.500 req/s
después de agregar el nodo: 50.000 × 0,80 = 40.000 req/s

16x el tráfico normal, de golpe, contra una base que aguanta 8.000
```

Y hay un segundo golpe encima del primero: esas 40.000 requests por segundo
**no son 40.000 queries distintas**. Las claves calientes reciben miles de
misses simultáneos, así que la misma query se dispara cientos de veces en
paralelo. Es un **cache stampede** masivo
([módulo 04, §6](../modules/04-caching/README.md)).

**Y el caso peor, que es el que de verdad pasa:** nadie necesita decidir nada.

```
Un nodo de Redis SE CAE.
nodos.length pasa de 4 a 3 solo.
El 75% de las claves se remapea.
La base recibe 15x el tráfico.
```

**La ampliación es una decisión que podés planificar. La caída de un nodo, no.**
Con `hash % N`, tu sistema tiene un modo de falla en el que **perder un nodo
de caché te tumba la base de datos** — y eso ocurre a las 3 de la mañana, no
un martes a las 15:00.

## 3. La solución probada

**Consistent hashing con nodos virtuales.** En vez de `hash(clave) % N`, se
mapean nodos **y** claves al mismo anillo de 0 a 2³²; cada clave pertenece al
primer nodo que se encuentra girando en sentido horario.

Al agregar un nodo, **sólo se remapean las claves que caen entre él y su
predecesor**: `1/N` en vez de `(N-1)/N`.

```
hash % N (4 -> 5):   79,9 % de las claves cambian de nodo
anillo   (4 -> 5):   14,3 %      ← cerca del mínimo teórico (20%)
```

Viene del paper de Karger et al. (1997), lo popularizó **Dynamo** de Amazon, y
lo usan Cassandra, Riak, memcached con `ketama`, las CDNs, y **Redis Cluster**
en una variante (16.384 *hash slots* fijos que se asignan a nodos).

Pero —y esto es la mitad del caso— **el anillo no alcanza solo**:

> **El anillo reduce el remapeo del 80% al 14%. Eso sigue siendo 7.160 req/s
> contra la base, 3x el tráfico normal, de golpe.**

Así que la solución completa son **cuatro capas**.

## 4. La implementación

### 4.1 El anillo, con nodos virtuales

```ts
export class AnilloConsistente {
  private puntos: [number, string][] = [];      // [posición, nodo], ordenado
  private readonly vnodos: number;

  constructor(nodos: string[], vnodos = 150) {
    this.vnodos = vnodos;
    for (const n of nodos) this.agregar(n);
  }

  agregar(nodo: string): void {
    for (let v = 0; v < this.vnodos; v++) {
      this.puntos.push([hash(`${nodo}#${v}`), nodo]);
    }
    this.puntos.sort((a, b) => a[0] - b[0]);
  }

  quitar(nodo: string): void {
    this.puntos = this.puntos.filter(([, n]) => n !== nodo);
  }

  /** Primer punto >= hash(clave), girando en sentido horario. */
  buscar(clave: string): string {
    const h = hash(clave);
    let lo = 0, hi = this.puntos.length - 1;
    if (h > this.puntos[hi][0]) return this.puntos[0][1];    // da la vuelta
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.puntos[mid][0] < h) lo = mid + 1; else hi = mid;
    }
    return this.puntos[lo][1];
  }
}
```

**Los nodos virtuales no son opcionales**, y el motivo no es sólo el reparto:

```
 vnodos por nodo    nodo más cargado    nodo menos cargado    desbalance
            1            252 %               21 %              11.84x   💀
          150            131 %               69 %               1.89x   ✅
```

Con 1 punto por nodo, el anillo queda lleno de huecos desparejos y **un nodo
recibe 12 veces lo del menos cargado**. Pero el segundo beneficio es el que
casi nadie menciona: **cuando un nodo se cae, sus claves se reparten entre
muchos vecinos** en lugar de caer todas sobre uno solo, que se saturaría al
instante.

150 es el número que usan Dynamo, Cassandra y la mayoría de las librerías.

### 4.2 El TTL con jitter — para que no expiren juntas

```ts
const TTL_BASE_S = 300;

function ttlConJitter(): number {
  return Math.floor(TTL_BASE_S * (0.75 + Math.random() * 0.5));   // 225 a 375 s
}

await redis.set(clave, valor, 'EX', ttlConJitter());
```

Esto cubre el **otro** escenario de misses masivos: todas las claves se
poblaron al mismo tiempo (después de un deploy o de que Redis volviera) y
**expiran al mismo tiempo**.

**Y la trampa que conviene conocer**
([`stampede.ts`](../modules/04-caching/stampede.ts)):

```
estrategia                 pico req/s a la base
ttl plano                            14.289   💀
ttl + jitter                         11.701   💀  ← apenas baja
single-flight                           954   ✅
```

**El jitter resuelve la expiración masiva, NO la clave caliente.** La clave
más popular se lleva el 18% del tráfico ella sola: cuando le toca expirar —en
el momento que sea— hay 180 requests llegando durante los 50 ms que tarda la
query, y las 180 van a la base.

**Jitter y single-flight resuelven problemas distintos y se usan juntos.** El
jitter solo es una falsa sensación de seguridad.

### 4.3 Single-flight — la defensa que de verdad corta el stampede

```ts
@Injectable()
export class CacheService {
  /** Deduplicación LOCAL: las requests concurrentes del mismo pod comparten la promesa. */
  private enVuelo = new Map<string, Promise<unknown>>();

  async get<T>(clave: string, cargar: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(clave);
    if (hit) return JSON.parse(hit);

    // 1) PRIMERA LÍNEA: 5 líneas, y reduce el stampede por un factor igual
    //    a tu concurrencia por pod. Casi nadie la pone.
    const yaVa = this.enVuelo.get(clave) as Promise<T> | undefined;
    if (yaVa) return yaVa;

    const p = this.cargarConLock(clave, cargar).finally(() => this.enVuelo.delete(clave));
    this.enVuelo.set(clave, p);
    return p;
  }

  /** 2) SEGUNDA LÍNEA: lock distribuido entre pods. */
  private async cargarConLock<T>(clave: string, cargar: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const gane = await this.redis.set(`lock:${clave}`, token, 'NX', 'PX', 5_000);

    if (!gane) {
      // Perdimos: preferimos servir VIEJO antes que esperar
      const stale = await this.redis.get(`stale:${clave}`);
      if (stale) {
        this.metricas.increment('cache.stale_servido');
        return JSON.parse(stale);
      }
      await sleep(30 + Math.random() * 40);       // con jitter, no todos a la vez
      return this.get(clave, cargar);
    }

    try {
      const valor = await cargar();
      const ttl = ttlConJitter();
      await this.redis.multi()
        .set(clave, JSON.stringify(valor), 'EX', ttl)
        .set(`stale:${clave}`, JSON.stringify(valor), 'EX', 3_600)   // red de seguridad
        .exec();
      return valor;
    } finally {
      await this.redis.eval(LIBERAR_SI_ES_MIO, 1, `lock:${clave}`, token);
    }
  }
}
```

Las tres reglas del lock, que son las del
[módulo 06, §7](../modules/06-idempotencia/README.md):

1. **TTL siempre**, calibrado: mayor que la query, menor que la paciencia del
   usuario. Si el pod que ganó muere, nadie consulta hasta que expire.
2. **Los perdedores nunca bloquean indefinidamente**: servir stale es mucho
   mejor que esperar.
3. **El `stale:` con TTL largo** como red de seguridad: siempre hay algo que
   servir.

### 4.4 El procedimiento de ampliación

Incluso con las tres capas anteriores, **la ampliación se hace de a un nodo**:

```
┌─ ANTES ────────────────────────────────────────────────────────┐
│ 1. Verificar que la base aguanta el pico esperado:            │
│    50.000 × 0,14 = 7.000 req/s  (¿la base da 7.000? Medilo.)  │
│ 2. Si no: precalentar el nodo nuevo ANTES de meterlo al       │
│    anillo (replicar las claves calientes).                    │
└────────────────────────────────────────────────────────────────┘
┌─ DURANTE ──────────────────────────────────────────────────────┐
│ 3. UN nodo a la vez. Nunca tres juntos.                       │
│ 4. Mirando el QPS de la base y el hit rate en vivo.           │
│ 5. Con el circuit breaker de la base activo (módulo 08).      │
└────────────────────────────────────────────────────────────────┘
┌─ DESPUÉS ──────────────────────────────────────────────────────┐
│ 6. Esperar a que el hit rate se recupere antes del siguiente. │
└────────────────────────────────────────────────────────────────┘
```

### 4.5 Y la causa de fondo: el 85% de memoria

El cluster estaba al **85% de memoria**, y eso es el error original. Con
consistent hashing, cuando un nodo de 4 se cae, los 3 restantes tienen que
absorber un 33% más de claves:

```
85% × 1,33 = 113 %   ->  llegan al maxmemory y EVICTAN masivamente
```

El hit rate se desploma **mucho más** que el 25% de claves perdidas, justo
cuando la base ya está recibiendo el tráfico extra. **Un efecto en cascada
disparado por un solo nodo.**

> **Regla: dimensioná el caché para sobrevivir a la pérdida de un nodo.** Con
> N nodos, quedate por debajo de `(N-1)/N` de memoria. Con 4 nodos, eso es
> **~75%**, no 85%.

Y el `maxmemory-policy` decide qué clase de desastre tenés:

```
allkeys-lfu   -> evicta lo menos pedido. Degrada, pero gradual.      ✅
allkeys-lru   -> evicta lo menos reciente. Un scan nocturno lo rompe. ⚠️
noeviction    -> los ESCRITOS FALLAN con OOM: el caché deja de
                 actualizarse por completo. Mucho peor.               💀
```

## 5. Por qué así y no de otra forma

### ❌ "Seguimos con `hash % N` pero avisamos antes"

No es una solución: es un procedimiento alrededor de un diseño roto. Y no
cubre el caso que importa: **la caída de un nodo no la planificás**. Con
`hash % N`, perder un nodo de caché remapea el 75% de las claves y te tumba la
base — a cualquier hora, sin que nadie haya decidido nada.

**El valor de consistent hashing no está en la ampliación planificada: está en
que la pérdida de un nodo sea un evento menor.**

### ❌ "Hacemos un `FLUSHALL` y precalentamos"

Suena limpio —empezar de cero— y es **estrictamente peor**: vaciás el 100% de
las claves en vez del 80%. El pico contra la base es mayor.

Y "precalentar" sólo funciona si sabés **qué** precalentar. Si tenés la lista
de las claves calientes, precalentar el **nodo nuevo** antes de meterlo al
anillo sí es buena idea (paso 2 arriba) — pero eso no es un `FLUSHALL`: es lo
contrario.

### ❌ "Usamos una instancia más grande en vez de más nodos"

**Escalar vertical el caché es una respuesta legítima** y a veces la correcta:
evita el remapeo por completo ([módulo 03, A1](../modules/03-escalabilidad/respuestas.md)).

Sus límites: hay un tamaño máximo de instancia; el failover de una instancia
grande deja el **100%** del caché frío en vez del 25%; y Redis es
single-threaded, así que una instancia más grande te da más memoria pero **no
más throughput de comandos**.

Si el problema es sólo memoria y estás lejos del techo, es la opción más
simple. Si además te falta throughput, no alcanza.

### ❌ "Ventana de mantenimiento con el tráfico cortado"

Resuelve este incidente y no el modo de falla: **el nodo que se cae no espera
la ventana**. Y en un sistema con usuarios en varias zonas horarias, la
ventana es cada vez más caro de conseguir.

Sirve como medida puntual para una migración grande, no como respuesta al
problema.

### ❌ "Subimos el TTL para que haya menos misses"

Empeora las dos cosas:

- Más datos viejos servidos (el costo de negocio del TTL).
- Y **no cambia nada** en el remapeo: la clave que ahora vive en otro nodo es
  un miss **sin importar su TTL**. El TTL gobierna cuándo expira, no dónde
  vive.

### ❌ "Que el caché sea opcional y listo"

Es la frase que suena más sensata y es la más peligrosa, porque **invita a no
medir**. El número que decide:

```
tráfico ÷ capacidad de la base SIN caché = 50.000 / 8.000 = 6,25x
```

> **Si tu tráfico supera la capacidad de la base sin caché, Redis NO es una
> optimización: es una dependencia crítica cuya disponibilidad multiplica la
> tuya** ([módulo 04, B3](../modules/04-caching/respuestas.md)).

Y entonces merece el tratamiento de una: réplicas, failover **probado**,
alertas de memoria mucho antes del 100%, y las defensas de abajo.

### ✅ Y la cuarta capa: que la base sobreviva igual

Porque incluso con todo lo anterior, el pico de 3x existe:

1. **Caché local en los pods con TTL de 5-10 s.** Lo más barato y lo que más
   compra: una clave con 3.000 req/s pasa a 0,2 req/s por pod. **Convierte el
   16x en algo que la base tolera**, y funciona con Redis completamente caído.
2. **Circuit breaker delante de la base** + load shedding: servir error en
   5 ms al 30% del tráfico es infinitamente mejor que morir para el 100%
   ([módulo 08](../modules/08-fiabilidad/)).
3. **Saber el número de antemano**, medido en una prueba de carga.

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **req/s a la base como % de su capacidad** | El número del incidente | **> 60%** |
| **Hit rate, y sobre todo su DERIVADA** | Una caída de 5 puntos es 6x la carga | **cayó > 2 puntos en 15 min** |
| **Hit rate por prefijo de clave**, no global | El global diluye una familia rota | Tendencia |
| **`evicted_keys` de Redis** | Llegaste al maxmemory | **> 0 sostenido** |
| **`used_memory / maxmemory` por nodo** | El 85% del incidente | **> 75%** con 4 nodos |
| **Desbalance entre nodos** (max/min de memoria) | Los vnodos están trabajando | **> 1,5x** |
| **Locks de single-flight adquiridos** | El stampede está contenido | Pico = algo expiró junto |

La segunda es la que habría avisado. **Alertá sobre la derivada, no sobre el
valor**: una alerta de "hit rate < 90%" te avisa cuando la base ya está en
llamas; una de "cayó 2 puntos en 15 minutos" te avisa mientras todavía podés
revertir ([módulo 04, B1](../modules/04-caching/respuestas.md)).

**Cómo lo testeás — y esto es lo valioso, porque se puede testear:**

```ts
it('agregar un nodo remapea menos del 20% de las claves', () => {
  const claves = Array.from({ length: 100_000 }, (_, i) => `producto:${i}`);
  const antes   = new AnilloConsistente(['n1', 'n2', 'n3', 'n4'], 150);
  const despues = new AnilloConsistente(['n1', 'n2', 'n3', 'n4', 'n5'], 150);

  const movidas = claves.filter((c) => antes.buscar(c) !== despues.buscar(c)).length;
  expect(movidas / claves.length).toBeLessThan(0.20);     // ← con módulo da 0,80
});

it('perder un nodo reparte sus claves entre TODOS los vecinos', () => {
  const anillo = new AnilloConsistente(['n1', 'n2', 'n3', 'n4'], 150);
  const huerfanas = claves.filter((c) => anillo.buscar(c) === 'n2');

  anillo.quitar('n2');
  const destinos = new Set(huerfanas.map((c) => anillo.buscar(c)));
  expect(destinos.size).toBe(3);         // ← con 1 vnodo caerían todas en uno
});

it('un stampede sobre la clave más caliente produce UNA sola query', async () => {
  const cargar = jest.fn().mockImplementation(() => sleep(50).then(() => 'valor'));
  await redis.del('caliente');

  await Promise.all(Array.from({ length: 500 }, () => cache.get('caliente', cargar)));
  expect(cargar).toHaveBeenCalledTimes(1);     // ← sin single-flight: 500
});
```

Y el que importa en producción: un **game day** que mate un nodo de Redis en
horario de baja carga y verifique que el QPS de la base se queda por debajo de
su umbral. Es la única forma de saber que el cálculo de memoria sigue vigente.

## 7. El costo

1. **Una dependencia más** (la librería de consistent hashing) o
   **Redis Cluster** con sus propias reglas: comandos multi-clave y
   transacciones necesitan que las claves estén en el mismo *hash slot*, lo
   que se resuelve con *hash tags* (`{user:123}:profile`) — y hay que
   acordarse.
2. **Los vnodos cuestan memoria y lookup**: `N × 150` entradas ordenadas en vez
   de `N`. Es baratísimo, pero no es cero.
3. **El pico de 3x sigue existiendo.** El anillo lo reduce, no lo elimina. Las
   otras tres capas no son opcionales.
4. **Capacidad de memoria "desperdiciada" por diseño**: quedarse en 75% en vez
   de 85% con 4 nodos es ~13% más de instancias. **Ese margen ES la
   protección**, y hay que defenderlo cuando alguien quiera optimizar costos.
5. **El single-flight agrega un lock** con sus propios problemas: TTL que
   calibrar, y el pod que muere con el lock tomado. Y suma latencia de cola:
   los que esperan pagan la query completa.
6. **El caché local hace que haya N copias no invalidables** por unos
   segundos. Para un catálogo está perfecto; para un saldo, no
   ([módulo 04, A6](../modules/04-caching/respuestas.md)).

**Y lo más barato de todo, que es lo primero que hay que hacer:** medir cuántas
req/s aguanta la base sin caché. Todo este caso existe porque ese número no se
conocía — y con él, la decisión de agregar un nodo habría incluido *"esto va a
mandarle 40.000 req/s a una base que aguanta 8.000"*.

---

## Fuentes

- **Karger et al.**, *Consistent Hashing and Random Trees* (1997) — el paper
  original: <https://dl.acm.org/doi/10.1145/258533.258660>
- **Amazon**, *Dynamo* (SOSP 2007) — consistent hashing con vnodos en
  producción: <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **Redis**, *Cluster specification* — los 16.384 hash slots:
  <https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>
- **Facebook**, *Scaling Memcache at Facebook* (NSDI 2013) — leases contra el
  stampede, a escala real:
  <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Redis**, *Key eviction policies*:
  <https://redis.io/docs/latest/develop/reference/eviction/>

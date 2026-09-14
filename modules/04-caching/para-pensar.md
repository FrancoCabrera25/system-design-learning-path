# Para pensar — Módulo 04, resuelto

Las tres del final del README. Si querés intentarlas, cerrá esto.

---

## 1. El hit rate cae de 99% a 94%: ¿cuánto más tráfico, y lo notarías?

### 1.1 La cuenta

Lo que llega a la base es `QPS × (1 − hit_rate)`:

```
antes:    QPS × 0,01
después:  QPS × 0,06

0,06 / 0,01 = 6x
```

**Seis veces el tráfico.** Con 80.000 req/s, la base pasa de **800 a 4.800
req/s**.

La trampa de esta pregunta es que "cae 5 puntos" **suena** a una degradación
del 5%. Es una degradación del **500%** en lo único que importa. Como el
tráfico a la base es proporcional a `1 − hit_rate` y ese número es chiquito,
cualquier cambio absoluto ahí es enorme en términos relativos:

| Hit rate | Tráfico a la base (relativo a 99%) |
| --- | --- |
| 99,5% | 0,5x |
| **99%** | **1x** (línea base) |
| 98% | 2x |
| 95% | 5x |
| **94%** | **6x** |
| 90% | 10x |
| 80% | 20x |

### 1.2 ¿Lo notarías antes de que se caiga? Casi seguro que no

Y ésta es la parte interesante. Mirá dónde **no** se ve:

| Dónde mirarías | Qué muestra | ¿Se nota? |
| --- | --- | --- |
| Latencia p99 de la API | `1,5 ms → 3,9 ms` de latencia efectiva de esa query | ❌ Invisible dentro de una request de 80 ms |
| CPU / memoria de Redis | Igual o **más baja** (sirve menos hits) | ❌ Todo verde |
| Latencia de Redis | Idéntica | ❌ |
| Errores 5xx | Ninguno, hasta que la base se satura | ❌ Hasta que es tarde |
| Tasa de acierto **global** | `99% → 94%` | ⚠️ Sólo si alguien lo grafica |
| **req/s contra la base** | `800 → 4.800` | ✅ **Acá está** |

O sea: **el único lugar donde se ve es en la carga de la base**, que es
precisamente la métrica que la mayoría de los equipos no tiene atada a un
umbral. Y aunque la tengas, 4.800 req/s "no parece nada" si no sabés que tu
base aguanta 6.000.

Peor todavía: **el hit rate global puede no moverse.** Si la causa es una
feature nueva que agrega una familia de claves con hit rate bajo, el promedio
ponderado se diluye. Podés tener `producto:*` al 99,5% y `recomendacion:*` al
20%, con un global de 96% que parece sano, mientras `recomendacion:*` le pega
a la base con todo.

### 1.3 Qué alertar, entonces

1. **La derivada del hit rate, no el valor.**
   `"el hit rate cayó más de 2 puntos en 15 minutos"`. Una alerta sobre
   "hit rate < 90%" te avisa cuando la base ya está en llamas; una sobre la
   **caída** te avisa mientras todavía hay margen para revertir el deploy.
2. **Hit rate por prefijo de clave**, no global. Es lo que atrapa el caso de
   arriba. Cuesta un `label` en la métrica y es la diferencia entre ver el
   problema y no verlo.
3. **req/s contra la base como porcentaje de su capacidad conocida.**
   La palabra clave es *conocida*: si nunca hiciste una prueba de carga, no
   tenés denominador y no podés poner el umbral. **Esa prueba es la tarea
   pendiente más común de todo este módulo.**
4. **`evicted_keys` de Redis > 0** sostenido. Significa que llegaste a
   `maxmemory` y estás perdiendo claves calientes. Es *leading*: pasa antes
   de que el hit rate se derrumbe.
5. **`used_memory / maxmemory > 75%`** como alerta preventiva.

### 1.4 Las causas típicas (para saber qué buscar cuando la alerta suene)

- **Un deploy cambió el formato de serialización.** Todas las claves viejas
  son inservibles. Se previene versionando el namespace:
  `cache:v13:user:123` (módulo 04, sección 5.4).
- **Llegaste al `maxmemory`** y Redis evicta lo caliente.
- **El "20% caliente" creció** más rápido que la memoria que le asignaste.
  Pasa naturalmente con el catálogo.
- **Una feature nueva agregó claves de baja reutilización** que desalojan a
  las calientes (`evicciones.ts`: el problema del scan).
- **Se cayó un nodo del cluster** y con `hash % N` se remapeó el 80%
  (módulo 03).

---

## 2. La foto de perfil que no se actualiza (y los 40 pods)

### 2.1 Por qué pasa

`TTL = 5 minutos` es una afirmación explícita: *"acepto servir datos de hasta
5 minutos de antigüedad"*. El usuario que acaba de cambiar su foto es el caso
donde esa afirmación es falsa — porque **él sabe** que cambió.

Y ése es el matiz que ordena todo: **el problema no es la desactualización, es
la desactualización visible para quien hizo el cambio.** A otro usuario le da
exactamente igual ver la foto vieja 3 minutos más. Al dueño, no.

### 2.2 Las soluciones, de peor a mejor para este caso

**(a) Bajar el TTL a 30 segundos.** *Costo:* 10x más misses sobre esa clave.
No lo resuelve — acota la ventana a 30 segundos de confusión. Es lo que hace
todo el mundo y muchas veces alcanza.

**(b) Invalidar al escribir** (`DEL user:123` en el update). *Costo:* tenés
que acertarle a **todas** las rutas de escritura. En un año hay una migración,
un script de soporte y un consumer de Kafka que también escriben el perfil, y
ninguno hace el `DEL`. Además arrastra el race de cache-aside (`respuestas.md`,
C2): una lectura concurrente puede reescribir el valor viejo **después** del
`DEL`.

**(c) Write-through en el update** — escribir el valor **nuevo** en el caché
en vez de borrarlo:

```ts
async updateUser(id: string, dto: UpdateDto) {
  const user = await this.repo.update(id, dto);
  await this.redis.set(`user:${id}`, JSON.stringify(user), 'EX', 300);
  return user;
}
```

Para este caso es notablemente bueno: **el que escribe es exactamente el que
va a leer**. Sigue teniendo el race (una lectura lenta puede pisarlo), pero la
ventana es mucho más chica y el caso común queda perfecto.

**(d) Versionar la clave** — `user:123:v{updatedAt}`. Al escribir cambia
`updatedAt`, así que la clave nueva **nunca existió** y la vieja queda
huérfana hasta que expire. **Elimina el race en vez de mitigarlo**, que es la
diferencia cualitativa. *Costo:* necesitás la versión en el momento de leer
(una clave chiquita `user:123:ver`, o `updatedAt` en el JWT/sesión).

### 2.3 Y para una FOTO en particular: no invalides, cambiá el nombre

Acá hay una respuesta que es mejor que las cuatro anteriores juntas, y sólo
aplica porque el dato es un **archivo**:

```
❌  https://cdn.midominio.com/avatars/user-123.jpg
✅  https://cdn.midominio.com/avatars/user-123/a3f9c1e7.jpg     <- hash del contenido
```

Si la URL contiene el **hash del contenido**, subir una foto nueva genera una
**URL nueva**. Y entonces:

| Capa | Qué pasa |
| --- | --- |
| Navegador del usuario | Pide una URL que nunca vio → descarga la nueva ✅ |
| CDN | Idem: URL nueva, miss, la trae del origen ✅ |
| Caché local de los 40 pods | Guardan el *perfil*, y el perfil cambió (la URL es distinta) ✅ |
| Redis | Idem ✅ |

**Invalidaste cuatro capas de caché —incluida la del navegador, a la que no
podés llegar de ninguna otra forma— sin invalidar nada.** Y como la URL es
inmutable, le podés poner `Cache-Control: max-age=31536000, immutable` y que
no se vuelva a pedir nunca.

Es la misma técnica que usan los bundlers con `app.a3f9c1e.js`. Regla general
y muy reutilizable:

> **Para contenido inmutable, no invalides: cambiá el identificador.** Es la
> versión física de la idea de versionar la clave.

Lo único que queda por invalidar es el **objeto perfil** que contiene esa URL
— que es chiquito, barato de refrescar, y para el que (c) o (d) alcanzan.

### 2.4 Ahora con 40 pods y caché local

Acá se cae la mitad de lo anterior. El `Map` vive en la memoria de **cada
proceso**: un `DEL` en Redis no toca las 40 copias.

| Solución | ¿Sigue funcionando con caché local? |
| --- | --- |
| (a) TTL corto | ✅ **Sí**, y es la única que funciona sin agregar nada — el TTL local vence solo |
| (b) `DEL` en Redis | ❌ **No.** Borra 1 de 41 copias |
| (c) Write-through | ❌ **No.** Escribe en Redis, no en los 40 `Map` |
| (d) Versionado de clave | ✅ **Sí**, y es la mejor |
| (e) URL con hash | ✅ **Sí** — resuelve todas las capas de una |

**Por qué el versionado gana con caché local:** si la versión viaja con la
request (en el JWT, o leída de una clave chica en Redis), los 40 pods buscan
`user:123:v8` y **ninguno la tiene**. La invalidación dejó de ser *una acción
sobre N cachés* y pasó a ser *una propiedad de la clave*. Es correcto por
construcción, no por coordinación.

**Si igual necesitás invalidación explícita en el nivel local**, hace falta
broadcast:

```ts
// El que escribe avisa a todos los pods
await this.redis.publish('cache:invalidate', JSON.stringify({ key: `user:${id}` }));

// Cada pod está suscrito y borra su copia local
this.sub.on('message', (_canal, msg) => {
  this.localCache.delete(JSON.parse(msg).key);
});
```

Y hay que asumir que esto es **best effort**: el pod que estaba reconectando a
Redis en ese instante **se pierde el aviso** y se queda con la copia vieja
hasta que expire. Por eso el **TTL local corto (5-30 s) nunca se saca**:
queda como red de seguridad debajo del pub/sub.

### 2.5 Mi recomendación concreta para este caso

1. La URL del avatar lleva **hash de contenido** → el archivo se resuelve
   solo, en las cuatro capas.
2. El objeto perfil, en Redis, con **write-through** en el update (el que
   edita ve su cambio al instante) y TTL de 5 minutos como red.
3. El nivel local, **TTL de 10 segundos** y nada más. Con esa ventana no hace
   falta pub/sub, y no hay nada que se pueda desincronizar por más de 10
   segundos.

Tres decisiones, cero locks, cero coordinación distribuida. Y hay una regla
general debajo: **el caché local aguanta TTL corto porque es barato de llenar;
el caché compartido aguanta TTL largo porque es caro.** Dos niveles, dos
políticas.

---

## 3. Se cae Redis: ¿te degradás o te caés? ¿Qué número necesitás?

### 3.1 El número, en una línea

> **¿Cuántas req/s sostiene tu base de datos SIN caché, medido en una prueba
> de carga — y cuánto tráfico tenés?**

```
tráfico ÷ capacidad_de_la_base_sin_caché
```

| Resultado | Qué significa |
| --- | --- |
| **< 1** | El caché es una **optimización**. Si se cae, se pone lento y sobrevivís. |
| **> 1** | El caché es una **dependencia crítica**. Si se cae, te caés. |

Con 80.000 req/s y una base que aguanta 6.000: **13x**. No es una
optimización. Es un componente del que depende tu disponibilidad, y su SLA
multiplica al tuyo (módulo 02).

**La respuesta honesta en la mayoría de los sistemas es: "es una dependencia
crítica y nunca lo tratamos como tal".**

Los números secundarios que hay que tener:

- **Cuánto tarda el failover de Redis.** No es instantáneo: son segundos de
  errores. ¿Tu app los reintenta o los propaga al usuario?
- **Cuánto tarda en repoblarse el caché** después de volver vacío.
- **Qué fracción del tráfico es cacheable.** Si el 40% de las lecturas ya va a
  la base igual, el golpe es menor de lo que parece.

### 3.2 Qué pasa, segundo a segundo (con 13x)

```
t = 0 s     Redis deja de responder
t = 0,1 s   los 80.000 req/s van íntegros a la base
t = 0,5 s   el pool de conexiones se agota
t = 1 s     las requests se encolan en la app; por Little, la concurrencia
            en vuelo explota; la memoria de los pods empieza a subir
t = 5 s     timeouts; los clientes REINTENTAN -> la carga sube todavía más
t = 20 s    5xx generalizados; endpoints que no usan caché también fallan,
            porque comparten el pool
t = 60 s    los livenessProbe fallan (event loop trabado) -> k8s reinicia
            pods -> el tráfico va a los que quedan -> caen más rápido
```

### 3.3 Cuando Redis vuelve, ¿se recupera solo? No

Tres razones, y la tercera es la que sorprende:

1. **Redis vuelve VACÍO.** El hit rate arranca en 0%. Todas las requests
   siguen yendo a la base durante el tiempo que tarde en repoblarse.
2. **Para repoblarse necesita que las queries terminen**, y la base está
   saturada. Círculo cerrado: no hay caché porque la base no responde, y la
   base no responde porque no hay caché.
3. **La carga ahora incluye los reintentos acumulados** de los minutos de
   caída. Es *más* que el tráfico original.

Es un **fallo metaestable** (módulo 01, sección 5): el sistema no vuelve al
estado bueno aunque desaparezca la causa. Hay que intervenir a mano — cortar
tráfico, precalentar, subir capacidad — y esa intervención rara vez está
escrita en un runbook antes de que pase.

### 3.4 Qué implementar para que sea degradación y no caída

En orden de relación beneficio/esfuerzo:

**1. Caché local en los pods, aunque sea con TTL de 5-10 segundos.**
Es lo más barato y lo más efectivo. Una clave con 3.000 req/s, con TTL local
de 5 s, se convierte en **0,2 req/s por pod**. Con 40 pods son 8 req/s contra
3.000. **Convierte el 13x en algo que la base tolera**, y funciona aunque
Redis esté completamente caído.

**2. Single-flight, también local.** Con hit rate 0, querés que haya **una**
query en vuelo por clave distinta por pod, no miles. Un
`Map<string, Promise>` son 5 líneas:

```ts
private enVuelo = new Map<string, Promise<unknown>>();

async get<T>(key: string, cargar: () => Promise<T>): Promise<T> {
  const yaVa = this.enVuelo.get(key);
  if (yaVa) return yaVa as Promise<T>;            // nos colgamos de la que ya está

  const p = cargar().finally(() => this.enVuelo.delete(key));
  this.enVuelo.set(key, p);
  return p;
}
```

**3. Circuit breaker delante de la base** (módulo 08). Cuando la base pasa su
umbral, se rechaza rápido el exceso. **Servir un error en 5 ms al 70% del
tráfico es infinitamente mejor que morir para el 100%** — y además deja a la
base con aire para responderle al 30% que sí pasa.

**4. Load shedding con prioridades.** No todo el tráfico vale lo mismo: tirá
primero bots, prefetch y endpoints de analytics; protegé el checkout y el
login. Requiere clasificar el tráfico de antemano, que es trabajo, pero es lo
que convierte una caída total en una degradación que el negocio tolera.

**5. Tratar a Redis como la dependencia crítica que es:** réplicas, failover
**probado** (no configurado: probado, con un game day), alertas de memoria
mucho antes del 100%, y capacidad dimensionada para sobrevivir a la pérdida
de un nodo (módulo 04, B4).

### 3.5 La respuesta de una frase

> **"Depende de un número que deberíamos tener y probablemente no tengamos:
> cuántas req/s aguanta la base sin caché. Si nuestro tráfico lo supera,
> Redis no es una optimización sino una dependencia crítica cuya
> disponibilidad multiplica la nuestra. Y no se recupera solo, porque vuelve
> vacío: es un fallo metaestable. Lo que lo convierte en degradación es caché
> local con TTL de segundos, single-flight y un circuit breaker que proteja la
> base — en ese orden, porque el primero es el más barato y el que más
> compra."**

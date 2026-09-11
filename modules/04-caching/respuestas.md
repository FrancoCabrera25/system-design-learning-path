# Respuestas modelo — Módulo 04

> Abrilo **después** de escribir las tuyas en `mis-respuestas/04.md`.

---

## Bloque A — Conceptos

### A1 — Cache stampede

**El mecanismo.** Una clave caliente expira. En el milisegundo siguiente,
todas las requests que la pedían hacen miss **a la vez** — y ninguna encuentra
el valor porque la primera todavía no terminó su query. Si la clave recibe
3.000 req/s y la query tarda 80 ms, se disparan **240 queries idénticas
simultáneas**. La base se satura, las queries tardan más, más requests se
acumulan, y cuando la base se recupera todo vuelve a expirar junto.

**Las defensas, y qué resuelve cada una:**

1. **Single-flight (lock).** Sólo la primera request va a la base; las demás
   esperan su resultado o reciben stale. Es **la** defensa contra el
   stampede: en la simulación baja el pico de 14.000 a 950 req/s.
2. **TTL con jitter** (`TTL × (0,75 + rand × 0,5)`). Evita que **muchas claves
   distintas** expiren juntas — el caso del deploy o del Redis que volvió.
   **No hace nada contra una clave caliente**, y ésa es la trampa de la
   pregunta (ver B2).
3. **Stale-while-revalidate.** Se sirve el valor vencido mientras uno refresca
   en background. Nadie espera. El costo no es técnico sino de negocio:
   aceptás servir datos viejos.
4. **Expiración probabilística temprana (XFetch).** Cada request, a medida que
   se acerca el vencimiento, tiene una probabilidad creciente de refrescar.
   Elegante: sin locks, sin coordinación, y estadísticamente una sola request
   refresca.
5. **Refresh-ahead**: un job refresca las claves más calientes antes de que
   venzan. Cuesta trabajo sobre claves que quizás ya nadie pide.

**La respuesta completa** dice que 1 y 2 resuelven problemas distintos y se
usan juntos.

### A2 — Los tres patrones

| | Cómo | Cuándo es correcto | El riesgo que asumís |
| --- | --- | --- | --- |
| **Cache-aside** | Miss → leo la base → escribo el caché | Default. Lecturas impredecibles, tolerás datos algo viejos | El primer acceso siempre es lento, y el race de C2 |
| **Write-through** | Escribo en la base **y** en el caché, sincrónicamente | El dato se lee siempre justo después de escribirse (un perfil que el usuario acaba de editar) | Cada escritura paga latencia doble, y cacheás cosas que nadie va a leer |
| **Write-behind** | Escribo en el caché; la base se actualiza después | Contadores de vistas, "me gusta", métricas: alto volumen de escritura, tolerancia a perder algo | **Si el caché se cae, perdés datos.** Es una decisión de negocio, no técnica |

El criterio: **cache-aside por defecto**. Write-through sólo si no tolerás
datos viejos *y* sabés que lo escrito se va a leer. Write-behind sólo si
podés escribir en un post-mortem "perdimos 30 segundos de contadores" y que
a nadie le importe.

### A3 — Por qué invalidar es difícil: tres razones técnicas

1. **No hay transacción entre la base y el caché.** Son dos sistemas
   distintos; no existe un commit que abarque a los dos. Cualquier orden que
   elijas (borrar antes, borrar después) tiene una ventana donde el proceso
   puede morir y dejarlos inconsistentes. Es el mismo problema del outbox del
   módulo 02, sin la solución del outbox.
2. **No sabés quién depende de qué.** Una clave cacheada suele ser el
   resultado de un **join o una agregación** de varias entidades. Cuando
   cambia una de ellas, ¿qué claves hay que invalidar? En la práctica nadie
   mantiene ese grafo de dependencias actualizado, y al año el `DEL` está en
   tres lugares del código y falta en un cuarto.
3. **La invalidación no llega a todos lados.** Con caché de dos niveles hay N
   copias locales en N pods; con CDN hay copias en 200 POPs; con
   `Cache-Control` hay copias en las máquinas de los usuarios, a las que
   **no podés llegar nunca**. `DEL` en Redis invalida un solo nivel de la pila.

La cuarta, que es la de fondo: **el race de cache-aside (C2)** — podés hacer
todo bien y aun así reescribir el valor viejo después de haberlo borrado.

### A4 — Cache penetration

**Qué es:** se piden claves **que no existen** (`user:999999999`). El caché
hace miss —correctamente, no hay nada que cachear— y la request va a la base,
que tampoco encuentra nada. **Cada request atraviesa el caché como si no
existiera.**

**Diferencia con el stampede:** el stampede es un problema de **timing** (la
clave existe pero acaba de vencer, y muchos van juntos). La penetración es un
problema de **ausencia**: el dato no existe, así que el caché nunca se puebla
y el problema es permanente, no un pico.

**Por qué un atacante lo usaría:** es la forma más barata de anular tu caché.
Generando IDs al azar con un script, lleva tu base del 1% al 100% del tráfico
sin necesitar ningún exploit — y desde afuera parece tráfico normal.

**Defensas:**

1. **Cachear el negativo.** Guardar un marcador de "no existe" con TTL corto
   (30-60 s). Resuelve el 95% de los casos con tres líneas. El TTL tiene que
   ser corto porque el recurso puede crearse después.
2. **Bloom filter** con todos los IDs existentes, en memoria del pod. Si el
   filtro dice "no está", **no está** (no tiene falsos negativos) y cortás sin
   tocar la base ni Redis. Un bloom filter de 100 millones de IDs con 1% de
   falsos positivos entra en ~120 MB. El costo: hay que mantenerlo
   actualizado.
3. Y la básica: **validar el formato del ID** antes de consultar nada. Si tus
   IDs son ULIDs, `999999999` ni siquiera es un ID válido.

### A5 — `allkeys-lru` vs `allkeys-lfu`

- **LRU** desaloja lo menos **recientemente** usado.
- **LFU** desaloja lo menos **frecuentemente** usado.

**El escenario donde la diferencia es dramática: cualquier acceso secuencial
masivo.** Un job nocturno que exporta la tabla entera, un backfill, un
crawler. Esas claves son **recientes pero no frecuentes**: para LRU son lo
más valioso que hay y desalojan todo lo caliente; para LFU son basura con 1
acceso y salen enseguida.

En la simulación, durante la ventana del job: **LRU conserva 20 de las 200
claves calientes y su hit rate cae 17 puntos; LFU conserva 142 y no se mueve.**

Se ve en producción como *"el sistema anda perfecto salvo todas las noches
entre las 2 y las 3"*. Y se arregla con una línea de configuración.

**Mi default para un caché de aplicación: `allkeys-lfu`** (Redis ≥ 4.0).
`allkeys-lru` sigue siendo razonable si el acceso es puramente temporal
(sesiones, tokens) y no hay scans. `volatile-*` sólo si en la misma instancia
conviven datos que no se pueden perder — que es algo que conviene no hacer.

### A6 — Caché de dos niveles (local + Redis)

**Qué ganás:** el nivel local se lee en ~0,01 ms contra ~1 ms de Redis, y
sobre todo **no cruza la red**. Para las claves súper calientes —las que se
leen 5.000 veces por segundo— te ahorra 5.000 round-trips por segundo y le
saca presión a Redis, que es single-threaded. También te da una segunda línea
de defensa si Redis se cae.

**El problema nuevo: N copias que no podés invalidar de forma sincronizada.**
Un `DEL` en Redis no toca los 40 `Map` locales. Después de un cambio, **tenés
40 versiones potencialmente distintas del mismo dato** conviviendo, y un
usuario ve una u otra según a qué pod caiga — lo que produce el bug más
irritante de todos: *"a veces aparece y a veces no"*.

**Qué puede ir en el nivel local:**

✅ Configuración, feature flags, catálogos, tablas de referencia, precios de
lista, permisos por rol (no por usuario). Todo lo que cambia poco y tolera
estar desactualizado unos segundos. **Siempre con TTL local corto: 5-30 s.**

❌ Datos por usuario que el propio usuario edita (ve su cambio o no según el
pod), saldos, stock, cualquier cosa donde la inconsistencia entre pods sea
visible o costosa.

Si necesitás nivel local para algo que cambia, hace falta **invalidación por
pub/sub**: el que escribe publica en un canal y los 40 pods borran su copia.
Sigue siendo *best effort* (si un pod estaba desconectado, se lo pierde), así
que el TTL corto queda como red de seguridad.

> **Rúbrica bloque A**
> - **Mid:** explica el stampede y conoce cache-aside.
> - **Senior:** distingue qué resuelve el jitter y qué el single-flight,
>   explica penetration vs stampede, y elige LFU con el caso del scan.
> - **Staff:** ve que el problema de fondo de la invalidación es que no hay
>   transacción entre los dos sistemas, y trata el caché local como un
>   sistema distribuido con su propia consistencia.

---

## Bloque B — Números

### B1 — El hit rate que se degrada

- **(a)** `80.000 × (1 − 0,99) = **800 req/s**`. La base está al 13% de su
  capacidad: cómoda.
- **(b)** `80.000 × (1 − 0,92) = **6.400 req/s**` contra una capacidad de
  6.000. **107% de la capacidad → no sobrevive.** Y es **8x** la carga
  anterior. Siete puntos de hit rate, ocho veces la carga: ésa es la no
  linealidad del módulo.

  Lo importante para una entrevista: **nadie rompió nada**. El caché
  funciona, Redis está sano, la aplicación no cambió su lógica. Un cambio de
  formato de serialización invalidó las claves viejas y eso alcanzó.
- **(c) Qué habría avisado antes, y sobre qué alertar exactamente:**
  - **La derivada del hit rate**, no el valor: *"el hit rate cayó más de 2
    puntos en 15 minutos"*. Una alerta sobre "hit rate < 90%" te avisa cuando
    la base ya está en llamas; una sobre la caída te avisa mientras todavía
    hay margen.
  - **`evicted_keys` de Redis** creciendo: significa que llegaste al
    `maxmemory` y estás perdiendo claves calientes.
  - **`used_memory / maxmemory > 75%`**: la alerta preventiva.
  - **Las req/s que la base recibe** como métrica de primera clase, con umbral
    en un porcentaje de la capacidad conocida. Si no sabés cuál es la
    capacidad de tu base, no podés poner este umbral — y ése es el problema
    real de la mayoría de los equipos.

### B2 — La clave caliente

- **(a)** `20.000 × 0,15 = 3.000 req/s` sobre esa clave. La query tarda 80 ms,
  y durante esos 80 ms **ninguna request encuentra el valor** (todavía no se
  escribió). Por Little: `3.000 × 0,08 = **240 queries idénticas simultáneas**`.
  Si el pool de la base tiene 50 conexiones, las 190 restantes se encolan o
  fallan — y arrastran a todos los demás endpoints, que comparten el pool.
- **(b) El jitter no ayuda prácticamente nada acá.** El jitter desparrama el
  vencimiento **entre claves distintas**. Con una sola clave, el vencimiento
  ocurre en un único instante: lo movés en el tiempo, pero cuando llegue
  siguen siendo 240 queries simultáneas.

  Es exactamente lo que muestra la simulación: con jitter el pico baja de
  14.289 a 11.701 req/s — todavía 6x la capacidad de la base. **Jitter es
  para el deploy; single-flight es para la clave caliente.**
- **(c) Single-flight en Redis:**

  ```ts
  async getConSingleFlight(key: string): Promise<string> {
    const hit = await this.redis.get(key);
    if (hit) return hit;

    const token = randomUUID();
    const gane = await this.redis.set(`lock:${key}`, token, 'NX', 'PX', 5000);

    if (!gane) {
      // Perdimos. Preferimos servir viejo antes que esperar:
      const stale = await this.redis.get(`stale:${key}`);
      if (stale) return stale;
      await sleep(50);                         // si no hay stale, esperamos
      return this.getConSingleFlight(key);     // y reintentamos
    }

    try {
      const valor = await this.repo.consultaPesada();
      await this.redis.set(key, valor, 'EX', 300);
      await this.redis.set(`stale:${key}`, valor, 'EX', 3600);  // red de seguridad
      return valor;
    } finally {
      await this.redis.eval(LIBERAR_SI_ES_MIO, 1, `lock:${key}`, token);
    }
  }
  ```

  **Si el pod que ganó el lock se muere antes de escribir el caché:** el lock
  queda tomado hasta que expire su `PX` (5 s). Durante esos 5 segundos
  **nadie consulta la base y nadie tiene el valor**. Si los perdedores
  bloquean esperando, tenés 3.000 req/s acumulándose durante 5 segundos:
  15.000 requests colgadas, y cuando el lock expire entran todas juntas.
  **La protección contra el stampede se convirtió en un stampede diferido.**

  De ahí salen las tres reglas del single-flight:
  1. **El TTL del lock siempre**, y calibrado: mayor que la query (si no,
     dos pods consultan igual) y menor que la paciencia del usuario.
  2. **Los perdedores nunca deben bloquear indefinidamente.** Servir stale es
     mucho mejor que esperar; si no hay stale, esperar con backoff y un
     límite, y devolver error o valor por defecto al vencerlo.
  3. **Un segundo valor con TTL largo (`stale:`)** como red de seguridad, para
     tener siempre algo que servir.

  (En un solo proceso Node, además, un `Map<string, Promise>` deduplica las
  requests concurrentes del mismo pod sin tocar Redis. Son 5 líneas y reduce
  el stampede por un factor igual a tu concurrencia por pod. Es la primera
  línea de defensa y casi nadie la pone.)

### B3 — Redis se cae 4 minutos

- **(a) Segundo 1:** los 80.000 req/s van íntegros a la base, que aguanta
  6.000. Son **13x su capacidad**. El pool de conexiones se agota de
  inmediato; las requests se encolan en la aplicación; por Little la
  concurrencia en vuelo explota; la memoria de los pods sube; los timeouts
  empiezan a disparar y los clientes reintentan, **sumando carga a un sistema
  que ya no da abasto**. En menos de un minuto: 5xx generalizados.
- **(b) ¿Se recupera solo cuando Redis vuelve? No.** Y las razones son las que
  distinguen una buena respuesta:
  1. **Redis vuelve VACÍO.** El hit rate arranca en 0%: todas las requests
     siguen yendo a la base durante el tiempo que tarde en repoblarse.
  2. **Repoblarlo requiere que las queries terminen**, y la base está
     saturada. Es un círculo: no hay caché porque la base no responde, y la
     base no responde porque no hay caché.
  3. **La carga ahora incluye los reintentos** acumulados de 4 minutos. Es más
     que el tráfico original.

  Es un **fallo metaestable** (módulo 01): el sistema no vuelve al estado
  bueno aunque desaparezca la causa original. Típicamente hay que intervenir a
  mano — cortar tráfico, precalentar el caché, subir capacidad.
- **(c) Qué hacer para que sea degradación y no caída:**
  1. **Circuit breaker delante de la base** (módulo 08). Cuando la base pasa
     su umbral, se rechaza rápido el exceso. **Servir un error a los 5 ms al
     70% del tráfico es infinitamente mejor que morir para el 100%.**
  2. **Load shedding con prioridades**: tirar primero el tráfico de menor
     valor (bots, endpoints de analytics, prefetch) y proteger el checkout.
  3. **Caché local en los pods**, aunque sea con TTL de 5-10 segundos. Para
     una clave con 3.000 req/s, un TTL local de 5 s la convierte en 0,2 req/s
     por pod. Es la diferencia entre 80.000 y unos pocos miles.
  4. **Single-flight** para que, aun con hit rate 0, sólo haya **una** query
     en vuelo por clave distinta en vez de miles.
  5. **Saber el número de antemano.** La pregunta *"¿cuántas req/s aguanta la
     base sin caché?"* hay que responderla en una prueba de carga, no en el
     incidente. Si la respuesta es "menos que nuestro tráfico", el caché **no
     es una optimización: es una dependencia crítica** y merece réplicas,
     failover probado y alertas propias.

### B4 — Se cae un nodo de 6 con consistent hashing

- **(a) ~1/6 = 16,7%** de las claves. Con 150 vnodos se reparten entre los 5
  restantes de forma bastante pareja (ése es el segundo beneficio de los
  vnodos que casi nadie menciona: sin ellos, **todas** las claves del caído
  caerían sobre un único vecino, que se saturaría).
- **(b)** Los 5 restantes tienen que absorber un 20% más de claves cada uno.
  **Si estaban al 85% de memoria, ahora necesitan el 102%.** Llegan al
  `maxmemory` y empiezan a **evictar masivamente** — no sólo las claves
  nuevas, también las calientes que ya tenían. El hit rate cae mucho más que
  el 16,7% que perdiste: se degrada en **todo el cluster**, justo cuando la
  base ya está recibiendo el tráfico extra del nodo caído. Es un efecto en
  cascada disparado por un solo nodo.
- **(c) El `maxmemory-policy` decide qué clase de desastre tenés:**
  - `allkeys-lru` / `allkeys-lfu`: el cluster **degrada** — evicta, el hit
    rate baja, la base sufre más. Malo pero gradual.
  - `noeviction`: los **escritos fallan con OOM**. El caché deja de
    actualizarse por completo: cada miss consulta la base **y no puede
    guardar el resultado**, así que la próxima vuelve a consultar. El hit
    rate se congela y después se desploma a medida que expira lo que había.
    Es mucho peor, y es el default en algunas configuraciones.

  La lección operativa: **dimensioná el caché para sobrevivir a la pérdida de
  un nodo.** Con 6 nodos, quedarte por debajo del ~80% de memoria es lo que
  te da margen para que la caída de uno no dispare evicciones en los otros.

> **Rúbrica bloque B**
> - **Mid:** calcula bien las req/s y sabe que hay que alertar el hit rate.
> - **Senior:** alerta sobre la derivada, critica su propio single-flight (el
>   pod que muere con el lock), y sabe que Redis vuelve vacío.
> - **Staff:** nombra el fallo metaestable, propone load shedding con
>   prioridades, y dimensiona el caché para tolerar la pérdida de un nodo.

---

## Bloque C — Aplicado a tu stack

### C1 — La foto de perfil que no se actualiza

**(a) Tres soluciones:**

1. **Bajar el TTL** (5 min → 30 s). *Costo:* 10x más misses sobre esa clave, o
   sea 10x más carga de esa query. No lo resuelve: acota la ventana. Es lo que
   hace todo el mundo y muchas veces alcanza.
2. **Invalidar al escribir** (`DEL user:123` en el `updateUser`). *Costo:*
   tenés que acertarle a **todas** las rutas de escritura — y en un año hay
   una migración, un script de soporte y un consumer de Kafka que también
   escriben, y ninguno hace el `DEL`. Además tiene el race de C2.
3. **Versionar la clave**: `user:123:v{updatedAt}`. Al escribir, cambia
   `updatedAt`, así que la clave nueva **nunca existió** y la vieja queda
   huérfana hasta que expire. *Costo:* necesitás conocer la versión en el
   momento de leer (se resuelve con una clave chiquita `user:123:ver` que se
   lee primero, o metiendo `updatedAt` en el JWT/sesión). **Es la única de las
   tres que elimina el race en vez de mitigarlo.**

(Una cuarta: **write-through** en el propio `updateUser` — escribís el valor
nuevo en el caché en vez de borrarlo. Sirve bien acá porque el usuario que
acaba de editar su perfil es exactamente el que lo va a leer.)

**(b) Con 40 pods y caché local además de Redis:**

- La **(1) TTL corto** sigue funcionando — es la única que funciona **sin
  agregar nada**, porque el TTL local vence solo. Por eso, si hay nivel local,
  el TTL local tiene que ser de segundos.
- La **(2) invalidación con `DEL`** deja de funcionar: `DEL` borra la copia de
  Redis, **no las 40 copias locales**. Para que funcione hay que agregar
  **broadcast por pub/sub**: el que escribe publica en un canal y los 40 pods
  borran su copia. Sigue siendo *best effort* (el pod que estaba reconectando
  se lo pierde), así que el TTL corto queda igual como red de seguridad.
- La **(3) versionado** sigue funcionando y es la que mejor escala al caso
  local: si la versión viaja con la request (en el JWT, o leída de Redis), los
  40 pods buscan `user:123:v8` y **ninguno tiene esa clave**. La invalidación
  deja de ser una acción sobre N cachés y pasa a ser una propiedad de la
  clave. Eso es lo que la hace correcta por construcción.

### C2 — El bug de concurrencia

**La secuencia:**

```
Request A (getUser)                Request B (updateUser)
────────────────────────────────────────────────────────
1. GET user:123      -> MISS
2. SELECT            -> "Juan"
                                   3. UPDATE -> "Pedro"
                                   4. DEL user:123
5. SET user:123 = "Juan"      <-- escribe el valor VIEJO
                                  DESPUÉS del DEL
```

**Resultado:** el caché sirve "Juan" durante los 300 segundos del TTL, aunque
la base diga "Pedro". No hay excepción, no hay log, no hay forma de detectarlo
salvo que un usuario se queje. La ventana es chica (los milisegundos entre el
`SELECT` de A y su `SET`), pero a 20.000 req/s "chica" significa "varias veces
por hora".

**Dos arreglos:**

1. **Versionar la clave** — `user:{id}:v{updatedAt}`. A escribe en
   `user:123:v7` (muerto, nadie lo va a pedir) y todos leen `user:123:v8`. El
   race **desaparece**, no se mitiga. Es mi elección.
2. **`SET` con `NX` en la ruta de lectura**, más un `DEL` en la de escritura:
   `SET user:123 "Juan" NX EX 300` sólo escribe si la clave **no existe**. Si
   B ya borró, A la recrea igual (el `DEL` deja la clave ausente, así que `NX`
   pasa) — o sea que **no alcanza solo**. La variante que sí funciona es
   escribir un tombstone: B hace `SET user:123 "__INVALIDO__" EX 5` en vez de
   `DEL`, y el `NX` de A falla. Feo pero efectivo.

Otras válidas: **TTL corto** (mitiga), **delayed double delete** (borrar,
actualizar, esperar 500 ms, borrar de nuevo — frágil y sorprendentemente
común), y **CDC** (la invalidación la dispara el WAL de Postgres vía Debezium,
así que ocurre siempre después del commit y en orden: correcto por
construcción, y mucha más infraestructura).

Y la pregunta que hay que hacerse antes de elegir: **¿cuánto dato viejo tolera
este caso?** Si la respuesta es "cero", no cachees, o cacheá con CDC. Si es
"unos segundos", el TTL corto resuelve el problema entero y todo lo demás es
sobre-ingeniería.

### C3 — Cachear un objeto de 8 MB

1. **Bloquea el event loop de Node** *(el específico de Node)*. `JSON.parse`
   de 8 MB tarda decenas de milisegundos **de CPU pura**, y Node es un hilo:
   durante ese tiempo **todas** las demás requests del pod están congeladas
   (módulo 01, sección 8). Aparece como un p99 pésimo en endpoints que no
   tienen nada que ver, y no lo ves en ninguna métrica de Redis ni de la base.
2. **Bloquea a Redis, que también es single-threaded.** Servir 8 MB ocupa el
   único hilo de Redis mientras dura; todos los demás clientes esperan. A esto
   se suma el ancho de banda: a 500 req/s son **4 GB/s**, que no existen.
3. **Rompe la economía de la memoria.** Con `maxmemory` de 8 GB entran 1.000
   claves de éstas: cualquier acceso variado dispara **evicciones masivas** y
   el hit rate se desploma. Además, en replicación y en los snapshots RDB las
   claves grandes producen picos de latencia.

El cuarto problema, conceptual: **no podés actualizar una parte**. Si cambia
un campo, reescribís los 8 MB.

**Qué hacer:** cachear **por pieza** (`producto:123`, `producto:124`) y armar
la respuesta en la aplicación, o cachear el resultado ya serializado como
string (evitás el `parse`, no el `stringify`), o paginar el endpoint — que
suele ser la señal real: un endpoint que devuelve 8 MB tiene un problema de
diseño de API antes que un problema de caché.

### C4 — Caché para un sistema de agentes

**Qué cachear** (la respuesta **no** es "la respuesta final", o al menos no
sólo eso). Hay cuatro capas, ordenadas por relación beneficio/riesgo:

1. **Los embeddings.** Convertir un texto en vector es determinístico y
   cuesta plata. Cachear por `hash(texto + modelo)` tiene hit rate alto y
   **riesgo cero**. Es la fruta más baja y casi nadie la toma.
2. **Los resultados de las herramientas.** Si el agente llama
   `getWeather("Buenos Aires")` tres veces en la misma conversación, la
   segunda y la tercera salen del caché. TTL según la volatilidad del dato.
3. **Los chunks recuperados del RAG** para una query dada.
4. **La respuesta del LLM.** La más jugosa y la más peligrosa (ver abajo).

Y una quinta que no es tuya: **el prompt caching del proveedor**. Si el
prefijo del prompt (system prompt, herramientas, documentos) es estable, el
proveedor lo cachea y cobra bastante menos por esos tokens. Es la optimización
de costo más grande y sólo requiere **ordenar el prompt de estable a
variable**. Mencionarlo demuestra que entendés dónde está la plata.

**La clave.** El texto exacto del prompt **no sirve** porque el hit rate sería
prácticamente cero: cada prompt lleva timestamp, nombre del usuario, historial
de la conversación, y la misma pregunta se escribe de cincuenta maneras
("¿cómo cancelo?" / "quiero cancelar" / "como hago para dar de baja"). Tres
opciones:

- **Exacta, sobre lo normalizado**: `hash(pregunta normalizada + modelo +
  temperatura + versión del system prompt + versión del índice RAG)`. Hit rate
  bajo, riesgo bajo. **Ojo con incluir la versión del prompt y del índice**:
  si no, un deploy que cambia el system prompt sigue sirviendo respuestas
  viejas generadas con el prompt anterior.
- **Semántica**: embebés la pregunta y buscás el vecino más cercano por
  encima de un umbral de similitud. Hit rate mucho más alto.
- **Por plantilla**: cacheás sólo intenciones conocidas y frecuentes,
  detectadas con un clasificador barato. Menos elegante, mucho más predecible.

**El riesgo de cachear respuestas de un LLM**, que es lo que la pregunta
busca, y hay tres:

1. **Falso positivo semántico — el peligro real.** *"¿Puedo cancelar mi
   suscripción?"* y *"¿Puedo cancelar mi suscripción **sin penalidad**?"*
   tienen una similitud coseno altísima y **respuestas opuestas**. Un caché
   de base de datos con clave exacta nunca te devuelve la fila equivocada; un
   caché semántico **sí**, con total confianza y sin ningún error. Un umbral
   mal calibrado convierte tu caché en una máquina de dar respuestas
   incorrectas. Mitigación: umbral alto y conservador, medir la tasa de
   falsos positivos con evals (módulo 14), y no cachear semánticamente
   preguntas que dependan de matices (importes, condiciones, plazos).
2. **Fuga de datos entre usuarios — el riesgo de seguridad.** Si la respuesta
   se generó con el contexto del usuario A (sus datos, sus documentos, sus
   permisos) y la clave no incluye el tenant y el alcance de permisos,
   **se la servís al usuario B**. La clave de un caché de LLM **siempre** tiene
   que estar scopeada por tenant y por nivel de acceso. Es la clase de bug
   que termina en un incidente de privacidad, no en un ticket.
3. **Respuestas que envejecen mal.** Un LLM responde sobre datos que cambian
   ("tu plan actual incluye..."). Una respuesta cacheada 24 horas puede pasar
   a ser falsa sin que nada la invalide. Por eso, en la práctica, el caché de
   la capa 4 conviene limitarlo a **preguntas de conocimiento general**, y las
   de datos del usuario se responden siempre.

La respuesta madura: *"cacheo agresivamente las capas 1-3, que son
determinísticas y sin riesgo; el prompt caching del proveedor me da el mayor
ahorro por el menor esfuerzo; y la respuesta final la cacheo sólo con clave
exacta normalizada y scopeada por tenant, midiendo falsos positivos antes de
habilitar caché semántico."*

> **Rúbrica bloque C**
> - **Mid:** ve el problema de la invalidación y propone bajar el TTL.
> - **Senior:** encuentra el race de C2 y lo explica paso a paso, sabe que
>   `JSON.parse` bloquea el event loop, y cachea embeddings y tools.
> - **Staff:** elige versionado porque elimina el race en vez de mitigarlo,
>   y en C4 identifica el falso positivo semántico y la fuga entre tenants.

---

## Bloque D — Diseño abierto

### D1 — El caché del feed

**Primero: no se cachea el feed armado con el contenido adentro.** Se cachea
una **lista de IDs de publicaciones** por usuario, y el contenido de cada
publicación se cachea **una sola vez** y se hidrata al leer. Si no, un post de
alguien con 3 millones de seguidores se guarda 3 millones de veces.

**Fan-out on write vs on read:**

| | Fan-out on write (push) | Fan-out on read (pull) |
| --- | --- | --- |
| Cuándo | Al publicar, escribo el ID en el feed de cada seguidor | Al leer, consulto los últimos posts de los seguidos y los mezclo |
| Lectura | **Rapidísima**: un `LRANGE` | Cara: N queries + merge |
| Escritura | **Cara**: 3M de escrituras por un solo post | Trivial |
| Rompe con | Cuentas con millones de seguidores | Usuarios que siguen a miles de cuentas |

**La elección es híbrida, y ésa es la respuesta correcta** (es lo que hacen
Twitter e Instagram):

- **Fan-out on write** para la abrumadora mayoría de los usuarios. Leer es lo
  que pasa 100 veces más seguido que escribir, y la lectura tiene que ser un
  `LRANGE` de 1 ms.
- **Fan-out on read** para las cuentas "celebridad" (más de ~100.000
  seguidores, un umbral que se ajusta midiendo). Sus posts **no** se escriben
  en 3 millones de feeds: se consultan al leer y se mezclan con el feed
  precomputado.

Por qué el híbrido: un post de una celebridad con fan-out on write genera **3
millones de escrituras en Redis** para un solo evento. Con 100 celebridades
publicando a la vez, son 300 millones de escrituras — y encima la mayoría van
a feeds de usuarios que **no van a abrir la app hoy**. Es trabajo desperdiciado
a escala industrial.

**Dos optimizaciones más que conviene nombrar:**

- **Sólo precomputar feeds de usuarios activos** (los que entraron en los
  últimos 7-30 días). Es típicamente el 20-30% de la base de usuarios, y
  recorta el trabajo y la memoria en la misma proporción. Al usuario que
  vuelve después de un mes se le arma el feed on-read la primera vez.
- **El feed es una lista acotada**, no infinita: los últimos 500-1.000 IDs. Lo
  más viejo se pagina contra la base.

**Estimación de memoria** (el número que cierra la respuesta):

```
5M DAU × 500 IDs × 8 bytes                   = 20 GB   sólo IDs
+ overhead de estructura de Redis (~2x)      ≈ 40 GB
```

Entra en un cluster de ElastiCache de tamaño razonable. Y la comparación que
justifica la decisión de diseño:

```
Si guardáramos el CONTENIDO en cada feed (~1 KB por post):
5M × 500 × 1 KB = 2,5 TB      <-- 60x más caro, con el mismo dato
                                   repetido millones de veces
```

Por eso se guardan IDs y se hidrata: **el contenido se cachea una vez por
post, no una vez por lector.**

### D2 — "Cacheemos todo con TTL de 1 hora"

**Las preguntas, antes de aceptar o rechazar:**

1. **¿"Todo" qué?** El caché no es una política global: es una decisión **por
   tipo de dato**. Un catálogo de productos y el saldo de una cuenta no
   pueden tener la misma política.
2. **Para cada tipo: ¿cuánta desactualización tolera el negocio?** Ésa es la
   única pregunta que define el TTL. Y la tiene que responder Producto, no
   Infraestructura.
3. **¿Cuál es el ratio lectura/escritura?** Cachear algo que se escribe tanto
   como se lee no ahorra nada y agrega inconsistencia.
4. **¿Alguno de esos datos determina permisos o seguridad?**
5. **¿Qué pasa si el caché se cae?** (B3). Si la respuesta es "se cae todo",
   estamos creando una dependencia crítica sin tratarla como tal.

**Dos casos donde TTL de 1 hora sería un bug grave:**

1. **Permisos, roles o tokens de sesión.** Le revocás el acceso a alguien que
   se fue de la empresa y **sigue entrando durante una hora**. Es un problema
   de seguridad, no de frescura, y el TTL lo convierte en política. Los
   permisos se cachean con TTL de segundos y **con invalidación explícita por
   evento**, o no se cachean.
2. **Stock, inventario o saldo.** Con un dato viejo de una hora vendés lo que
   no tenés: overselling, cancelaciones, reembolsos y clientes enojados. Acá
   el caché puede servir para **mostrar** ("quedan pocas unidades") pero
   **nunca** para **decidir**: la reserva se hace contra la base, con la
   transacción real.

Un tercero que suma si lo agregás: **feature flags y kill switches**. Toda la
gracia de un kill switch es poder apagar algo roto **ahora**. Con un TTL de
una hora, tu mecanismo de emergencia tarda una hora en hacer efecto — el día
que más lo necesitás.

**Cómo lo diría en la reunión, sin frenar a nadie:**

> *"De acuerdo con cachear agresivamente lo que tolera estar viejo — catálogo,
> configuración, perfiles públicos — y ahí una hora me parece bien. Armemos la
> tabla de qué dato tolera cuánto, y separemos lo que se usa para **mostrar**
> de lo que se usa para **decidir**. Lo que decide no se cachea, o se cachea
> con invalidación explícita."*

Esa distinción —**mostrar vs decidir**— resuelve el 90% de las discusiones
sobre qué cachear, y es una frase que vale la pena tener lista.

> **Rúbrica bloque D**
> - **Mid:** conoce fan-out on write y on read y elige uno.
> - **Senior:** propone el híbrido con umbral de celebridad, cachea IDs y no
>   contenido, y separa el TTL por tipo de dato.
> - **Staff:** estima la memoria y compara contra la alternativa, precomputa
>   sólo usuarios activos, y trae la distinción mostrar/decidir.

---

## Fuentes para profundizar

- **Facebook**, *Scaling Memcache at Facebook* (NSDI 2013) — leases contra el
  stampede, a escala real:
  <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Vattani, Chierichetti, Lowenstein**, *Optimal Probabilistic Cache
  Stampede Prevention* (VLDB 2015):
  <https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf>
- **Redis**, políticas de evicción (incluye cómo funciona el LFU aproximado):
  <https://redis.io/docs/latest/develop/reference/eviction/>
- **AWS**, *Caching strategies and best practices*:
  <https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html>
- **RFC 5861**, `stale-while-revalidate`: <https://www.rfc-editor.org/rfc/rfc5861>
- **Twitter**, *Timelines at Scale* — el híbrido de fan-out:
  <https://www.infoq.com/presentations/Twitter-Timeline-Scalability/>

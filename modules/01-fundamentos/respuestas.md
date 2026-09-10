# Respuestas modelo — Módulo 01

> Abrilo **después** de escribir las tuyas en `mis-respuestas/01.md`.
>
> No busques coincidencia literal. Buscá si tu respuesta **tiene el mismo
> número y el mismo trade-off nombrado**. Al final de cada bloque hay una
> rúbrica: qué respondería alguien de nivel mid, senior y staff.

---

## Bloque A — Conceptos

### A1 — El promedio miente

El promedio es una medida de tendencia central sobre una distribución que
**no es central**: la latencia tiene cola larga a la derecha. Un p50 de 20 ms
con un p99 de 2 s te da un promedio de ~45 ms que no describe a **ningún**
usuario real: ni a los rápidos ni a los lentos.

Los tres números que pediría:

1. **p50** — cómo se siente el sistema para la mayoría. Es tu línea base.
2. **p99** — el peor caso *común*. A 10.000 req/s son 100 usuarios por
   segundo sufriéndolo. Es lo que genera tickets de soporte.
3. **p99.9 o el máximo** — dónde está el techo real. Delata timeouts, GC
   pauses, reintentos. Si p99.9 es 30 s, tenés un timeout mal puesto.

Y un cuarto que casi nadie pide: **la tasa de errores junto a la latencia**.
Un p99 que "mejora" porque el servicio empezó a devolver 500 rápido no es
una mejora. Latencia sin tasa de éxito al lado es una métrica engañosa.

*Bonus (Gil Tene, "coordinated omission"):* casi todas las herramientas de
load testing miden mal el p99, porque cuando el sistema se traba dejan de
mandar carga y no registran las requests que "deberían" haber salido. El p99
real suele ser bastante peor que el que reporta tu herramienta.

### A2 — Amplificación de cola

> Si una request de usuario necesita N dependencias en paralelo y espera a
> todas, la latencia percibida es la del **más lento** de los N. Entonces la
> probabilidad de pegarle a un caso lento no es la de un servicio: es
> `1 - (1 - p)^N`.

Ejemplo numérico: con servicios de p99 = 100 ms (o sea, 1% de chance de ser
lento cada uno):

- 1 dependencia → 1% de usuarios afectados.
- 10 → `1 - 0,99¹⁰` = **9,6%**.
- 100 → `1 - 0,99¹⁰⁰` = **63%**.

Con 100 dependencias, **el p99 de tus servicios es el p37 de tu usuario**.
La cola dejó de ser la cola: es el caso normal.

Qué se hace: bajar el fan-out, timeouts con degradación (devolver parcial a
tiempo), *hedged requests* (mandar a 2 réplicas, quedarse con la primera —
cuesta ~5% de carga extra y corta la cola dramáticamente), y sobre todo
atacar la **causa** del p99 (GC, contención, cache miss) en vez de agregar
máquinas: escalar horizontalmente no arregla un p99 causado por una pausa de
GC que ocurre en todos los procesos por igual.

### A3 — 85% de CPU no es "aprovechar bien"

Porque la latencia no crece linealmente con la carga: crece como
`W = S / (1 - ρ)`.

| Utilización | Multiplicador de latencia |
| --- | --- |
| 50% | 2x |
| 70% | 3,3x |
| 85% | 6,7x |
| 90% | 10x |
| 95% | 20x |

A 85% ya estás con **6,7x la latencia de servicio**, y estás a un pico de
tráfico del 10% de saltar a 10x o 20x. Peor: cuando eso pasa, los clientes
llegan al timeout y **reintentan**, lo que sube la carga todavía más, lo que
sube la latencia todavía más → **colapso metaestable**. El sistema no vuelve
solo aunque el tráfico original baje, porque la carga ahora es tráfico real
+ reintentos.

Ese 30-40% "ocioso" no se desperdicia: es lo que paga los picos, los
deploys, y la instancia que se cae y le deja el trabajo a las otras. Correr
`cola-mm1.ts` muestra el efecto con números propios.

### A4 — SLI / SLO / SLA

- **SLI** = la *medición*. "% de requests con latencia < 300 ms".
- **SLO** = el *objetivo interno* sobre esa medición, con ventana temporal
  explícita. "99,9% en 30 días rodantes".
- **SLA** = el *contrato* con el cliente, con consecuencia comercial
  (reembolso, penalidad) si se incumple.

El SLO tiene que ser más estricto que el SLA porque el SLO es tu **alarma
temprana** y el SLA es la **línea donde pagás**. Si son iguales, te enterás
de que incumpliste el contrato al mismo tiempo que el cliente: no te queda
margen para reaccionar. La práctica habitual es que el SLO esté un nueve o
medio nueve por encima (SLA 99,9% → SLO interno 99,95%).

Segunda razón, menos obvia: el SLA se mide como lo mide el **cliente** (desde
afuera, incluyendo red y CDN), y el SLO como lo medís vos (desde adentro).
Siempre hay una brecha entre las dos mediciones, y esa brecha se paga con el
margen entre SLO y SLA.

### A5 — Error budget

`Error budget = 1 - SLO`. Es la cantidad de falla que te podés permitir
**a propósito**, tratada como un recurso que se gasta.

Con SLO 99,95% mensual: `0,0005 × 43.200 min = 21,6 minutos` de presupuesto.
Ya gastaste 14 min en 9 días → **65% del presupuesto en el 30% del mes**.

Decisión concreta: **congelar cambios riesgosos** (migraciones de esquema,
deploys de servicios en el camino crítico, cambios de infraestructura) por lo
que queda del mes, y redirigir capacidad del equipo a las causas de esos 14
minutos. Se sigue deployando lo de bajo riesgo, con feature flags y canary.

Cómo se lo explicás a Producto — y esta parte es la que evalúan de verdad —
**no** como "no se puede":

> "Tenemos 21 minutos de caída permitidos por mes; ya usamos 14 en 9 días.
> Si lanzamos esto la semana que viene sin estabilizar, la probabilidad de
> incumplir el compromiso con clientes es alta, y ahí el costo no es técnico:
> es comercial. Propongo dos semanas de estabilización y lanzamos el día 1
> del mes que viene con presupuesto completo — o lanzamos ahora detrás de un
> feature flag al 5% de usuarios, que consume presupuesto acotado."

Lo importante: el error budget convierte una discusión de opiniones
("¿estamos yendo muy rápido?") en una de números, con una regla acordada de
antemano. Ese es todo su valor político.

> **Rúbrica bloque A**
> - **Mid:** define bien SLI/SLO/SLA y sabe que el promedio no sirve.
> - **Senior:** trae los números (nueves → minutos, utilización → multiplicador)
>   y conecta p99 con experiencia de usuario a un QPS dado.
> - **Staff:** nombra colapso metaestable, coordinated omission, y usa el error
>   budget como herramienta de negociación con Producto, no como métrica.

---

## Bloque B — Números

### B1 — 5M DAU × 20 acciones

- **(a)** `5.000.000 × 20 = 100M acciones/día`; `100M / 86.400 ≈ 1.160 QPS`.
  (Truco mental: 86.400 ≈ 100.000, entonces 100M/100k = **1.000 QPS**. Con
  eso alcanza para una entrevista.)
- **(b)** Factor pico. Si es una app de uso humano en una sola región, el
  tráfico se concentra en ~6-8 horas → ×3 a ×5. Si tiene eventos (partido,
  Black Friday, notificación push masiva) → ×10 o más. **Elijo ×5 →
  ~5.800 QPS pico**, y lo digo explícito: *"asumo tráfico humano regional sin
  eventos masivos; si hay push masivos, esto cambia a ×10 y el diseño de
  ingest tiene que absorber ráfagas, no promedio"*.
  **Lo que evalúan acá no es el número: es que declares el supuesto.**
- **(c)** `100M × 500 B = 50 GB/día`. × 730 días = **36,5 TB**. Con
  replicación ×3 = **~110 TB**. Más índices (regla gruesa: +30-50% del
  tamaño de los datos si indexás varias columnas).
- **(d)** No por el volumen total (36 TB fríos van a S3 sin drama), sino por:
  1. **Escrituras**: ~5.800 escrituras/s pico ya es incómodo para un solo
     primario de Postgres con índices y fsync. Ahí sí.
  2. **Working set**: cuando el conjunto de datos *calientes* no entra en la
     RAM de la instancia más grande disponible, la latencia se cae por un
     precipicio (pasás de leer de memoria a leer de disco).
  3. **Tiempo de operación**: cuando un `VACUUM`, un backup o una migración
     ya no entran en la ventana de mantenimiento.
  El orden importa: **sharding es la última herramienta, no la primera**.
  Antes van: índices correctos, réplicas de lectura, particionado por tiempo
  (`pg_partman`), archivado a S3, y recién ahí sharding.

### B2 — Ley de Little

- **(a)** `L = λ × W = 800 × 0,25 = **200 requests concurrentes**`.
- **(b)** `200 / 40 = **5 pods**` (más margen: nunca dimensiones al 100%,
  con la sección 5 en la cabeza → 5 pods al 100% son 8 pods al 65%).
- **(c)** `L = 800 × 0,4 = 320` → **8 pods** (o 12-13 con margen). Es decir,
  **+60% de capacidad necesaria sin que el tráfico haya cambiado en nada**.

Esa es la respuesta clave: **una degradación de latencia es, automáticamente,
una crisis de capacidad**. Si el pool de la base se pone lento, tu app
necesita más pods; si el autoscaler no llega a tiempo, la cola crece, la
latencia sube más, y necesitás todavía más pods. Es el mismo lazo de
realimentación de A3, visto desde el otro lado.

### B3 — Fan-out de 4 llamadas

- **(a) p50 del endpoint ≈ 60-100 ms, NO 20 ms.** Para que la request sea
  rápida, las **cuatro** tienen que ser rápidas. El p50 del máximo de 4
  muestras es el percentil `0,5^(1/4) = 0,84` → **el p84 de un servicio
  individual**, que está bastante por encima de su p50.
- **(b) p99 del endpoint > 200 ms, claramente.** Necesitás
  `F(x)⁴ = 0,99` → `F(x) = 0,9975` → el endpoint hereda el **p99.75** de cada
  servicio, no el p99. Y la proporción de requests que pegan al menos un
  servicio en su 1% lento es `1 - 0,99⁴ = **3,9%**`. O sea: casi 4 de cada
  100 usuarios ven ≥ 200 ms.
- **(c) Secuenciales:** las latencias se **suman**.
  - p50 ≈ `4 × 20 = 80 ms` — *peor* que el paralelo en el caso típico.
  - p99 **no** es `4 × 200 = 800 ms`: es bastante menos, porque es muy
    improbable que las cuatro estén simultáneamente en su peor 1%. La suma
    **concentra** (ley de los grandes números), el máximo **dispersa**.

  El trade-off, dicho como se dice en una entrevista: *"paralelo optimiza el
  caso típico y castiga la cola; secuencial empeora el caso típico pero tiene
  una cola más predecible. Con 4 dependencias voy a paralelo con un timeout
  global y degradación parcial; si fueran 40, el paralelo puro es
  insostenible y hay que reducir el fan-out o precalcular."*

### B4 — Disponibilidad compuesta

- **(a)** `0,999³ = 0,997002` → **99,70%**.
- **(b)** `0,003 × 43.200 min = **129,6 minutos/mes**` (~2,2 horas), **aun
  si tu código no falla nunca**.
- **(c)** Dos cambios que suben el techo sin tocar B, C ni D:
  1. **Sacar dependencias del camino crítico.** Si D es "mandar el mail de
     confirmación", no tiene por qué estar en la request síncrona: escribís
     el evento en la misma transacción (patrón **outbox**, módulo 09) y
     respondés. Si D está caído, el mail sale más tarde, pero tu request
     tuvo éxito. Cada dependencia que sacás del camino crítico **te devuelve
     su factor entero** en la multiplicación.
  2. **Degradación elegante con timeout + fallback.** Si C es "traer
     recomendaciones personalizadas", ponés timeout de 150 ms y, al vencer,
     devolvés recomendaciones genéricas cacheadas. C sigue teniendo 99,9%,
     pero *tu* disponibilidad ya no depende de C — depende de que tengas un
     fallback. C pasó de dependencia dura a mejora opcional.

  (Terceras opciones válidas: caché de respuestas de B con TTL, para servir
  stale cuando B está caído; circuit breaker con respuesta por defecto;
  redundancia de la propia dependencia si tenés varios proveedores.)

  **La versión corta de esta pregunta, que es lo que quieren escuchar:**
  *"la disponibilidad compuesta se multiplica sólo para dependencias
  síncronas y duras. Convertir dependencias en asíncronas o en opcionales es
  la palanca de disponibilidad más barata que existe."*

### B5 — 385 ms perdidos

En orden de probabilidad:

1. **Distancia física (~120 ms de RTT Buenos Aires ↔ Virginia).** La luz en
   fibra hace ~200 km/ms y hay ~8.000 km. **Esto no se optimiza, se evita**:
   CDN/edge o región más cercana (`sa-east-1`).
2. **Handshakes en conexión fría.** DNS (1 RTT) + TCP (1 RTT) + TLS (1-2
   RTT) = **3-4 RTTs antes del primer byte útil** → `4 × 120 = 480 ms` en el
   peor caso. Con keep-alive, HTTP/2 y TLS 1.3 (1-RTT, o 0-RTT en reanudación)
   esto baja muchísimo. **Éste suele ser el mayor arreglo posible.**
3. **Waterfall del cliente.** Si el front hace 3 requests encadenadas (auth →
   perfil → datos), son 3 RTTs secuenciales = 360 ms sólo de ida y vuelta.
   Se arregla con un BFF que agregue, o con paralelizar.
4. **Overhead de infraestructura**: ALB, WAF, API Gateway, service mesh —
   suman single-digit ms cada uno, pero suman.
5. **Cold start / cola** en el propio servidor: los 15 ms son el tiempo de
   *handler*, no el tiempo de *cola antes del handler* (sección 5 otra vez).

La lección de fondo, y la frase que conviene decir: **"el 96% de la latencia
percibida no estaba en el código; estaba en la red y en cuántas veces la
cruzamos"**. Optimizar el `SELECT` de 15 ms a 8 ms no lo nota nadie.

> **Rúbrica bloque B**
> - **Mid:** hace las cuentas bien pero no declara supuestos ni redondea al orden.
> - **Senior:** declara supuestos, redondea al orden de magnitud, y traduce
>   el número a una decisión ("por eso NO hace falta sharding todavía").
> - **Staff:** ve el lazo de realimentación (latencia → capacidad → latencia)
>   y distingue "el número que manda" del resto del cálculo.

---

## Bloque C — Aplicado a tu stack

### C1 — p50 de 12 ms, p99 de 3 s, base tranquila

Que el **p50 esté sano y la base también** descarta "la query es lenta". El
problema está entre medio. En orden:

1. **Event loop lag.** Alguna otra ruta del mismo proceso hace trabajo de CPU
   sincrónico (parseo de un payload grande, `JSON.stringify` de una respuesta
   enorme, crypto, un `map` sobre 100k elementos). Node es un hilo: mientras
   eso corre, **tu query rápida está esperando en la cola del event loop**.
   *Cómo lo confirmás:* `perf_hooks.monitorEventLoopDelay()` exportado como
   métrica, y correlacionar sus picos con los picos de p99. Es la causa #1 y
   casi nadie la mide.
2. **Cola de espera del pool de conexiones.** El pool está saturado por
   *otras* queries lentas; la tuya tarda 12 ms en ejecutarse pero espera
   2,9 s para conseguir una conexión. *Cómo lo confirmás:* métrica de
   `pool.waitingCount` / tiempo de adquisición de conexión, separada del
   tiempo de query. Si tu instrumentación mide sólo "tiempo de query", este
   caso es literalmente invisible.
3. **Pausas de GC.** Un heap grande con muchos objetos vivos (caché en
   memoria, buffers) genera pausas de major GC de cientos de ms. *Cómo lo
   confirmás:* `--trace-gc` o la métrica `nodejs_gc_duration_seconds`.
4. **Efectos de infraestructura**: reciclado de pods (el pod que arranca
   recibe tráfico antes de estar caliente — JIT frío, pools vacíos, DNS sin
   cachear), *noisy neighbor* en el nodo, o un `readinessProbe` mal calibrado.
   *Cómo lo confirmás:* graficar p99 **por pod**, no agregado. Si el p99 alto
   vive en 1 de 15 pods, no es tu código.

Nota transversal: casi ninguna de las cuatro se arregla escalando
horizontalmente. La 1 y la 3 se replican idénticas en cada pod nuevo.

### C2 — 15 pods × 30 conexiones vs. 400 de límite

**El problema:** `15 × 30 = 450 > 400`. Ya estás por encima del límite, y el
pool es *por proceso*, así que ninguna app "sabe" del total. Cuando la base
llega al máximo, los intentos nuevos reciben
`FATAL: sorry, too many clients already` — que en NestJS aparece como error
500 en endpoints que no tienen nada de malo.

**En un autoscaling a 25 pods:** `25 × 30 = 750` conexiones intentadas contra
un límite de 400. Y acá está lo perverso: **el autoscaling se dispara
justamente cuando hay más carga**, o sea que el mecanismo que debería
salvarte es el que te tumba la base. Peor todavía, cada conexión de Postgres
es un **proceso del sistema operativo** con su propia memoria (varios MB): 400
conexiones activas ya generan contención de CPU por context switching mucho
antes de dar throughput útil.

**La solución, en orden:**

1. **PgBouncer en modo `transaction`** entre la app y Postgres. Los pods se
   conectan a PgBouncer (miles de conexiones baratas) y PgBouncer mantiene un
   pool chico y real contra Postgres (por ejemplo 50-80). Es el arreglo
   estándar y de menor esfuerzo. Advertencia: en modo `transaction` no podés
   usar sentencias preparadas con nombre a nivel sesión, `LISTEN/NOTIFY` ni
   temp tables entre transacciones — hay que verificar el driver (con
   `node-postgres` y TypeORM/Prisma hay flags específicos para esto).
2. **Dimensionar el pool con Little, no con intuición.** Si hacés 2.000
   queries/s de 4 ms: `L = 2.000 × 0,004 = 8` conexiones activas. Un pool de
   30 por pod no acelera nada — sólo garantiza que puedas matar a la base.
   La regla clásica (PgBouncer/HikariCP) es `conexiones ≈ núcleos × 2 + husos`,
   no "cuantas más mejor".
3. **Límite global**: `max_connections` alto no es la solución, es la trampa.

### C3 — Consumer de Kafka con lag creciente ⚠️ pregunta trampa

- **Concurrencia necesaria (Little):** `L = 1.200 msg/s × 0,08 s = **96**`
  mensajes en procesamiento simultáneo.
- **¿Alcanza con agregar instancias del consumer? NO.**

  En un consumer group, **cada partición la consume exactamente un consumer**.
  Con 6 particiones, el paralelismo máximo del grupo es **6 consumers**; el
  séptimo queda idle sin recibir nada. Con 6 consumers procesando de a un
  mensaje por vez a 80 ms cada uno, el throughput total es
  `6 × (1 / 0,08) = **75 msg/s**` contra 1.200 que llegan. El lag no sólo
  crece: crece rápido y para siempre.

  **La partición es la unidad de paralelismo en Kafka. No las instancias.**

- **Opciones reales, con su costo:**
  1. **Más particiones** (necesitás ≥ 96 para el modelo de a uno por vez).
     Costo: el número de particiones **no se puede reducir**, cambia el
     mapeo `key → partición` (rompe el orden de los mensajes en vuelo
     durante el cambio), y multiplica metadata en el broker.
  2. **Concurrencia dentro del consumer**: traer un batch de una partición y
     procesar los mensajes en paralelo. Costo: **perdés el orden dentro de la
     partición** y el manejo de offsets se vuelve delicado (no podés commitear
     el offset N hasta que todo ≤ N terminó, o perdés mensajes en un rebalance).
     Sólo es válido si el procesamiento es idempotente y sin orden — módulo 06.
  3. **Bajar los 80 ms** (batchear las escrituras a la base, sacar una llamada
     HTTP sincrónica del handler). Suele ser la opción más barata y la que
     nadie prueba primero.
  4. **Desacoplar**: el consumer sólo valida y reencola en un topic con más
     particiones, o delega a un pool de workers con su propia cola.

  La respuesta que buscan en una entrevista: **"antes de escalar consumers,
  ¿cuántas particiones tiene el topic?"**. Módulo 07 completo.

### C4 — `POST /chat` síncrono contra un LLM de 3-40 s

Todo lo que se rompe:

1. **Timeouts en cascada.** ALB (60 s por defecto), API Gateway (**29 s,
   límite duro**), Cloudflare (100 s), el cliente HTTP del front, el
   `keep-alive` del proxy. Con 40 s de generación, **API Gateway corta la
   conexión antes de que el modelo termine** — y el usuario ve un error
   mientras vos ya pagaste todos los tokens.
2. **Ley de Little contra tu propia infra.** A 100 req/s con 20 s promedio:
   `L = 2.000` requests en vuelo. Son 2.000 sockets, 2.000 contextos y
   2.000 timers vivos al mismo tiempo. Cualquier deploy los mata a todos.
3. **Un deploy = pérdida total de trabajo en curso.** Con requests de 40 s,
   cada rolling update destruye todo lo que estaba corriendo, sin manera de
   retomarlo: el estado sólo existía en memoria del pod.
4. **Los reintentos son catastróficos.** El cliente reintenta a los 30 s
   creyendo que falló; el backend arranca *otra* generación. **Pagás dos
   veces y el usuario puede recibir dos respuestas distintas.** Sin
   idempotencia (módulo 06 y 13), un reintento no es gratis: cuesta dinero.
5. **No hay backpressure.** Si el proveedor de LLM te rate-limitea, tus
   requests se acumulan en tu propio proceso hasta que se cae, en vez de
   acumularse en una cola que podés observar y controlar.
6. **UX pésima.** 40 segundos con un spinner y sin poder cancelar.

**El diseño correcto:**

```
POST /conversations/:id/messages        (Idempotency-Key en el header)
   -> valida, persiste el mensaje, publica evento en Kafka/SQS
   -> responde 202 Accepted { messageId, status: "processing" }   [~30 ms]

Worker (consumer)
   -> toma el evento, llama al LLM con STREAMING
   -> emite tokens a un canal (Redis pub/sub, WebSocket, SSE)
   -> persiste la respuesta final + la traza

Cliente
   -> se suscribe a GET /conversations/:id/stream  (SSE)
   -> ve tokens a medida que salen: el "primer token" a ~500 ms
      hace que 40 segundos se sientan aceptables
   -> si se cae la conexión, reconecta y recupera desde el estado persistido
```

Lo que ganás, punto por punto contra la lista de arriba: la request HTTP dura
30 ms (no hay timeout que valga), el trabajo en vuelo vive en la cola (un
deploy no lo pierde: el mensaje no se commitea hasta terminar), la
`Idempotency-Key` hace que un reintento devuelva el mismo `messageId` sin
volver a pagar, la cola te da backpressure observable (lag de Kafka = tu
métrica de saturación), y el streaming arregla la UX sin cambiar la latencia
real.

Esto es, básicamente, el módulo 14 entero. Si esta respuesta te salió
completa, ese módulo te va a resultar fácil.

> **Rúbrica bloque C**
> - **Mid:** identifica el timeout y propone "hacerlo asíncrono".
> - **Senior:** nombra el límite concreto (29 s de API Gateway), diseña el
>   flujo 202 + evento + streaming, y menciona idempotencia.
> - **Staff:** cuantifica el costo del reintento en dólares, ve el problema
>   del deploy destruyendo trabajo en vuelo, y elige dónde vive el estado.

---

## Bloque D — Diseño abierto

### D1 — Notificaciones, 2M DAU

**Las 5 preguntas de aclaración** (esta parte vale más que el diseño):

1. **¿Qué canales?** Push, email, SMS, in-app. Cada uno tiene proveedor,
   costo, latencia y semántica de entrega distintos. SMS cuesta ~USD 0,05;
   push es gratis. Eso solo ya cambia el diseño.
2. **¿Cuál es el requisito de latencia por tipo?** Un código 2FA es
   "segundos o es inútil". Un resumen semanal es "algún momento del martes".
   **Si todas las notificaciones tienen el mismo pipeline, estás
   sobre-diseñando las lentas y sub-diseñando las urgentes.**
3. **¿Fan-out?** ¿Es 1 evento → 1 usuario (transaccional), o 1 evento → 5
   millones de usuarios (broadcast de marketing)? Son **dos sistemas
   completamente distintos**; el segundo tiene un pico brutal y necesita
   rate limiting hacia los proveedores.
4. **¿Qué garantía de entrega?** *At-least-once* (puede duplicar: aceptable
   en un push de "tenés un mensaje nuevo") o *exactly-once percibido* (un
   push duplicado que diga "se debitaron $5.000" es un incidente). Esto
   define si necesito deduplicación e idempotencia end-to-end.
5. **¿Preferencias, quiet hours y compliance?** ¿Hay opt-out por canal?
   ¿No molestar de 23 a 8 en la zona horaria **del usuario**? ¿GDPR?
   Esto no es "un detalle de producto": mete un servicio de preferencias en
   el camino crítico de cada envío y un scheduler por timezone.

**Números que estimaría antes de dibujar nada:**

- Notificaciones por usuario por día (¿2? ¿20?) → eventos/día → QPS promedio.
- **Factor pico**, que acá es lo que importa: un broadcast de marketing
  genera 5M de notificaciones en 2 minutos = **~42.000/s**, contra un
  promedio de ~46/s. **Un factor pico de ~900x.** Ese número es el diseño.
- Rate limit de cada proveedor (APNs, FCM, SES, Twilio). **Si FCM te acepta
  600 req/s, tu pico de 42.000/s no es un problema tuyo de escala: es un
  problema de cola y de shaping.** Sin ese dato, el diseño es fantasía.
- Costo por canal × volumen. SMS a 5M usuarios = USD 250.000. **Ese número
  suele matar el requisito antes que cualquier consideración técnica.**

**¿Síncrona o asíncrona?** Asíncrona, sin dudarlo, y el número que lo
justifica es el factor pico de ~900x combinado con el rate limit del
proveedor. La cola no está ahí "para escalar": está ahí para **absorber una
ráfaga de 42.000/s y drenarla a los 600/s que el proveedor acepta**, sin
perder nada y sin que el usuario que dispara el broadcast espere. Ese es el
rol real de una cola: *desacoplar la tasa de producción de la de consumo*.
Cualquier otra justificación ("desacopla", "es más escalable") es más débil
que ésta.

Boceto mínimo: `API → topic de eventos → servicio de preferencias/filtrado →
colas por canal (con rate limiting y prioridad) → workers por proveedor →
DLQ + reintentos con backoff → tabla de estado por notificación para
deduplicar e idempotencia`. Prioridad separada: **una cola distinta para las
transaccionales urgentes**, para que un broadcast de marketing no deje el
código 2FA de alguien atrás de 5 millones de mensajes. Esto último es la
observación que distingue una buena respuesta.

### D2 — "Metamos Kafka, así escala"

Qué le respondo, sin ser condescendiente:

> "Puede que sí. ¿Qué problema estamos resolviendo? Porque a 40 req/s el
> throughput no es. Si es desacoplar equipos, o poder reprocesar histórico,
> o absorber picos, son razones válidas — y quiero entender cuál es, porque
> cada una tiene una solución distinta y algunas son más baratas."

**El número que le pido: el factor pico y el requisito de retención.**
40 req/s de promedio no dice nada. Si el pico es 40 req/s, Kafka es
sobredimensionar por dos órdenes de magnitud. Si el pico es 40.000/s durante
30 segundos una vez por día, la conversación es completamente distinta.

Y le ofrezco las alternativas honestas, ordenadas por costo operativo:

| Necesidad real | Solución más barata que Kafka |
| --- | --- |
| Sacar trabajo del request | Una cola simple: **SQS**, o BullMQ sobre el Redis que ya tenés |
| Desacoplar productor/consumidor | **SNS + SQS** o **EventBridge**: managed, sin brokers que operar |
| Absorber picos | SQS aguanta ráfagas enormes sin tunear nada |
| **Reprocesar histórico / varios consumidores independientes del mismo stream / orden por clave garantizado** | **Kafka de verdad** — acá sí gana |

El costo que hay que nombrar en voz alta: Kafka **no es una cola, es un log
distribuido**, y trae consigo particiones que hay que dimensionar bien desde
el principio (no se pueden reducir), rebalances, gestión de offsets,
consumer lag como métrica crítica, y un equipo que tiene que aprender todo
eso. Con MSK evitás operar brokers, pero **no evitás la complejidad
conceptual, que es la cara**.

La postura correcta no es "no": es **"sí, cuando tengamos el problema que
Kafka resuelve mejor que SQS — y ese problema tiene nombre y número"**.

> **Rúbrica bloque D**
> - **Mid:** empieza a dibujar cajas antes de preguntar. Es el error #1.
> - **Senior:** pregunta primero, estima, y justifica cada decisión con un número.
> - **Staff:** encuentra el número que *invalida* el requisito (el costo de SMS,
>   el rate limit del proveedor) y separa las clases de tráfico por prioridad.

---

## Fuentes para profundizar

- **Google SRE Book**, caps. 3-4 (*Embracing Risk*, *Service Level Objectives*)
  — error budgets y nueves: <https://sre.google/sre-book/embracing-risk/>
- **Dean & Barroso**, *The Tail at Scale* (CACM 2013) — hedged requests,
  amplificación de cola: <https://research.google/pubs/the-tail-at-scale/>
- **Gil Tene**, *How NOT to Measure Latency* — coordinated omission:
  <https://www.youtube.com/watch?v=lJ8ydIuPFeU>
- **Marc Brooker**, *Metastable Failures in Distributed Systems* — por qué el
  sistema no vuelve solo: <https://brooker.co.za/blog/>
- **Alex Xu**, *System Design Interview vol. 1*, cap. 2 (back-of-the-envelope).
- **PgBouncer**, modos de pooling: <https://www.pgbouncer.org/features.html>
- **Kafka docs**, *Consumer groups y particiones*:
  <https://kafka.apache.org/documentation/#intro_consumers>

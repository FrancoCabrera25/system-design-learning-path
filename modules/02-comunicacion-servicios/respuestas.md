# Respuestas modelo — Módulo 02

> Abrilo **después** de escribir las tuyas en `mis-respuestas/02.md`.

---

## Bloque A — Conceptos

### A1 — Cuándo síncrono, cuándo asíncrono

El criterio operativo, en una frase:

> **¿El que llama necesita el resultado para poder continuar?** Si sí,
> síncrono. Si no, asíncrono.

Y el test práctico para desempatar cuando hay dudas:

> **"¿Qué pasa si esto ocurre 5 minutos más tarde?"** Si la respuesta es
> "nada grave", sacalo del camino crítico.

**Síncrono:** consultas (reads), validaciones que condicionan la respuesta
(¿hay stock?, ¿el token es válido?, ¿cuál es el precio?), cualquier cosa
cuyo resultado cambia lo que le mostrás al usuario ahora.

**Asíncrono:** efectos secundarios (mail, push, indexado, analytics, audit
log), operaciones lentas o de latencia impredecible (LLM, video, proveedor
externo), hechos que le interesan a varios consumidores (`OrderCreated`), y
todo lo que necesite absorber picos.

Lo que hace fuerte a esta respuesta en una entrevista es cerrar con el
número del módulo 01: *"y además cada dependencia síncrona me multiplica la
disponibilidad. Con cuatro dependencias de 99,9% mi techo es 99,6%, o sea
2,9 horas de caída al mes. Cada una que saco del camino crítico me devuelve
su factor entero."*

### A2 — `send()` sobre Kafka NO es asíncrono

**No tiene razón.** Hay que separar tres cosas que se confunden todo el
tiempo:

1. **`async/await` de JavaScript** — un detalle del modelo de concurrencia
   de Node. No dice nada sobre arquitectura.
2. **El transporte** (HTTP, gRPC, Kafka) — cómo viajan los bytes.
3. **El acoplamiento temporal** — si el emisor necesita al receptor vivo
   *ahora*. **Esto es lo único que define síncrono vs asíncrono en
   arquitectura.**

`client.send()` en NestJS es **request/response**: crea un topic de respuesta,
manda el mensaje, y **se queda esperando la respuesta**. Es RPC. Que el
transporte sea Kafka no cambia nada — de hecho lo empeora, porque le agregás
la latencia de un broker a una llamada que igual bloquea. Es lo peor de los
dos mundos: la latencia de Kafka con el acoplamiento de gRPC.

**Consecuencia práctica sobre disponibilidad:** si el servicio `user` está
caído, este `send()` **falla igual** que un `GET /users/:id` por HTTP. No
ganaste disponibilidad; sólo agregaste un broker más al camino crítico —
o sea, una dependencia más que multiplicar.

Lo asíncrono en NestJS es `client.emit()`: publicar y seguir, sin esperar.

### A3 — Los cinco costos de pasar a asíncrono

1. **Consistencia eventual.** El estado del sistema queda temporalmente
   inconsistente: la orden existe pero el envío todavía no está reservado.
   Hay que decidir qué le mostrás al usuario en esa ventana. → *módulo 06*
2. **Entrega duplicada (at-least-once).** Prácticamente todos los brokers
   garantizan "al menos una vez", no "exactamente una". Tu consumer va a
   recibir el mismo mensaje dos veces, tarde o temprano. Todo handler tiene
   que ser **idempotente**. → *módulo 06*
3. **Orden no garantizado.** Sólo tenés orden dentro de una partición de
   Kafka y con la misma clave. `OrderUpdated` puede llegar antes que
   `OrderCreated`. → *módulo 07*
4. **Atomicidad entre la base y el broker.** Guardás en Postgres y publicás
   en Kafka: no hay transacción que abarque las dos. Si el proceso muere en
   el medio, quedás inconsistente. → *outbox, módulo 09*
5. **Observabilidad y debugging.** Una request ya no es una traza lineal: es
   un árbol de eventos que ocurren en momentos distintos, en procesos
   distintos. Sin trace ID propagado por el mensaje, debuggear es
   arqueología. → *módulo 10*

Bonus que suma mucho si lo agregás: **manejo de fallo permanente**. En
síncrono, si falla devolvés un 500 y el problema es del cliente. En
asíncrono, ¿qué hacés con un mensaje que falla 50 veces? Necesitás DLQ,
alertas sobre la DLQ, y un proceso humano para reprocesarla. → *módulo 08*

### A4 — Timeout vs deadline

- **Timeout**: *"espero como máximo 500 ms"*. Es **local** al cliente y **no
  viaja**. Cada servicio de la cadena tiene el suyo, sin coordinación.
- **Deadline** (gRPC): *"esta operación tiene que estar terminada antes del
  instante T"*. Es un **momento absoluto** que **se propaga por metadata** a
  toda la cadena de llamadas.

Por qué importa en `A → B → C`:

Con **timeouts** de 500 ms en cada salto: A espera 500 ms a B; B ya consumió
400 ms haciendo otras cosas y recién ahí llama a C con *su* timeout de 500 ms.
C se toma 450 ms y responde perfectamente... pero A ya cortó hace rato. **C
hizo 450 ms de trabajo para nadie**: consumió una conexión de base, CPU,
quizás escribió algo. Bajo carga, ese trabajo desperdiciado es exactamente lo
que te impide recuperarte.

Con **deadline**: A manda `deadline = ahora + 500 ms`. B recibe el deadline
absoluto, consume 400 ms, y al llamar a C le pasa el mismo deadline — C ve
que le quedan 100 ms y, si sabe que no llega, **falla inmediatamente con
`DEADLINE_EXCEEDED` sin empezar el trabajo**.

La frase que resume esto en una entrevista: **"el deadline convierte trabajo
desperdiciado en un fallo rápido, y bajo carga eso es la diferencia entre
degradarse y colapsar"**.

Regla operativa: **toda llamada gRPC lleva deadline, siempre.** Sin deadline
el default es esperar para siempre (ver B5).

### A5 — Monolito distribuido

Un sistema partido en servicios que **no se pueden deployar ni fallar de
forma independiente**: tenés todos los costos de lo distribuido y ninguno de
sus beneficios.

Tres síntomas **observables**:

1. **Deploys acoplados y ordenados.** El release incluye 4 servicios que
   tienen que salir juntos y en un orden específico. Verificable mirando el
   pipeline de CD o las notas de release.
2. **Base de datos compartida.** Dos o más servicios leen/escriben las
   mismas tablas. Verificable con un grep de connection strings.
   Es el síntoma más grave: no podés cambiar un esquema sin coordinar
   equipos, y perdiste la propiedad de los datos.
3. **Cadenas síncronas largas.** Una traza de request cruza 5+ servicios de
   forma sincrónica. Verificable en el tracing distribuido, si lo tenés.

Síntomas menores pero delatores: repositorio de tipos/DTOs compartido que
todos los servicios importan como librería y que cambia todas las semanas;
imposibilidad de correr un servicio localmente sin levantar otros seis.

**El test de una pregunta:**

> *"¿Puedo deployar este servicio un viernes a las 6 de la tarde sin
> coordinar con ningún otro equipo?"*

Si la respuesta es no, no es un microservicio: es un módulo del monolito con
latencia de red agregada y un pipeline más complicado.

> **Rúbrica bloque A**
> - **Mid:** sabe la diferencia conceptual sync/async y define bien monolito distribuido.
> - **Senior:** separa transporte de acoplamiento temporal, nombra el costo
>   de lo asíncrono con nombre propio, y explica deadline vs timeout.
> - **Staff:** conecta con el número de disponibilidad compuesta, da síntomas
>   verificables (no sensaciones) y habla de propiedad de datos.

---

## Bloque B — gRPC y contratos

### B1 — Dos razones, formato y transporte

**Formato — Protocol Buffers (binario, con schema compilado).** El mensaje
no lleva los nombres de los campos: lleva **números de campo codificados en
varint**. `{"userId": 8412337}` son 19 bytes de texto en JSON; en protobuf
es 1 byte de tag + 4 bytes de varint = 5 bytes. En mensajes con listas
repetidas la reducción llega al 60-70%, porque JSON repite cada nombre de
campo como texto en cada elemento. Además, parsear binario con offsets es
mucho más barato que parsear texto — y en Node ese parseo bloquea el event
loop, así que el ahorro se paga dos veces.

**Transporte — HTTP/2 multiplexado.** Muchas llamadas concurrentes viajan
por **una sola conexión TCP**, sin head-of-line blocking a nivel HTTP y sin
handshakes nuevos. Con HTTP/1.1 necesitás un pool de conexiones (cada una
con su handshake TCP+TLS) y sólo una request en vuelo por conexión. Sumale
compresión de headers (HPACK): la metadata repetida no se retransmite.

Y el tercero, que no es de performance pero suele ser el que más vale:
**el `.proto` es un contrato compilado**. Si alguien cambia un tipo, se
rompe el build, no producción a las 3 de la mañana.

### B2 — Evolución del `.proto`

- **(a) Agregar `string description = 4;`** → ✅ **Seguro.** Número nuevo,
  campo nuevo. Los consumidores viejos lo ignoran (forward compatibility por
  diseño de protobuf); los nuevos lo leen vacío en los mensajes viejos.
  Es la única forma segura de cambiar un schema.

- **(b) Renombrar `amount` → `amount_cents` (mismo número)** → ✅ **Seguro
  en el cable**, porque **el nombre no viaja**: viaja el número 2. Los bytes
  son idénticos.
  ⚠️ Pero **rompe el código fuente** de todo el que regenere los stubs: el
  getter pasa de `getAmount()` a `getAmountCents()`. Es un cambio *breaking*
  de compilación, no de runtime. Se maneja coordinando el bump de la
  librería de stubs, no con un deploy urgente.
  Ojo aparte: si tu pipeline usa el mapeo a JSON (`json_name`), el
  renombrado **sí** viaja. Ahí deja de ser gratis.

- **(c) `int32 amount = 2` → `int64 amount = 2`** → ✅ **Seguro**, y es la
  excepción que hay que conocer. `int32`, `int64`, `uint32`, `uint64` y
  `bool` comparten el mismo wire type (varint) y son **compatibles entre
  sí**. Un consumidor viejo que lee `int32` un valor que ahora entra en 64
  bits va a truncarlo, pero mientras los valores reales quepan en 32 bits no
  pasa nada. **No** son compatibles: `int32 ↔ string`, `int32 ↔ bytes`,
  `int32 ↔ sint32` (zigzag, codificación distinta), ni `int32 ↔ fixed32`.

- **(d) Borrar `currency` y reusar el número 3 para `country`** →
  ❌ **Catastrófico, y es la peor opción posible.**
  Durante el rolling update conviven productores viejos y nuevos. Un
  consumidor **nuevo** recibe un mensaje de un productor **viejo** con el
  campo 3 = `"ARS"` y lo interpreta como `country = "ARS"`. **Sin ningún
  error**: los dos son strings, el wire type coincide, el parseo funciona
  perfecto. Los datos se corrompen en silencio y el bug aparece semanas
  después en un reporte que no cierra.
  Lo correcto:
  ```protobuf
  reserved 3;
  reserved "currency";
  string country = 4;
  ```
  `reserved` existe exactamente para que el compilador impida este error
  dentro de dos años, cuando ninguno de los dos siga en la empresa.

- **(e) Agregar un valor a un enum** → ⚠️ **Depende, y es una trampa común.**
  En proto3 el campo se parsea bien (el valor desconocido se preserva), pero
  **el código del consumidor viejo no sabe qué hacer con él**. Si tenés un
  `switch` sin `default`, o un `default` que tira excepción, el consumidor
  viejo explota al recibir el valor nuevo. La regla: todo `switch` sobre un
  enum de un contrato externo necesita una rama por defecto **definida como
  comportamiento**, no como error.

**La regla general que engloba todo esto: *expand / migrate / contract*.**
Nunca cambies un contrato en un solo deploy. (1) Agregás lo nuevo y
deployás; (2) migrás a todos los consumidores y deployás; (3) recién
entonces borrás lo viejo y lo marcás `reserved`.

### B3 — El HPA escala y los pods nuevos quedan vacíos

**Causa: gRPC usa conexiones HTTP/2 persistentes, y un `Service` ClusterIP
balancea a nivel L4 (conexiones), no L7 (requests).**

El cliente abre **una** conexión TCP, kube-proxy la asigna a un pod, y esa
conexión queda pegada a ese pod **para siempre**. Todas las requests
posteriores — multiplexadas sobre esa misma conexión HTTP/2 — van al mismo
pod. Cuando el HPA levanta 7 pods nuevos, **nadie abre conexiones nuevas
hacia ellos**, así que quedan al 2%. Peor: el HPA ve la CPU promedio alta,
sigue escalando, y agrega más pods vacíos, que bajan el promedio y después
lo hacen escalar en yo-yo.

Es uno de los bugs de producción más clásicos de gRPC en Kubernetes.

**Dos soluciones distintas:**

1. **Balanceo L7 en el data path.** Un proxy que entienda HTTP/2 y balancee
   *por request*, no por conexión: un service mesh (Istio/Envoy, Linkerd) o
   un ALB con soporte gRPC. Cada request se rutea independientemente. Es la
   solución más transparente para las aplicaciones.
2. **Client-side load balancing.** El cliente resuelve un **headless
   Service** (`clusterIP: None`), obtiene **todas** las IPs de los pods,
   abre una subconexión a cada uno y aplica `round_robin` él mismo. En
   `@grpc/grpc-js` es `dns:///mi-servicio.namespace.svc.cluster.local` con
   `loadBalancingConfig: [{ round_robin: {} }]`. Sin proxy en el medio, pero
   el cliente tiene que reaccionar a cambios de endpoints (y necesitás
   cuidar el TTL de DNS).

Solución parcial y barata que conviene mencionar: **`MAX_CONNECTION_AGE`** en
el server. Cierra las conexiones cada N minutos y fuerza al cliente a
reconectar, con lo que el tráfico se redistribuye. No es balanceo real, pero
mitiga el desbalance sin cambiar la arquitectura.

### B4 — Cuándo NO usar gRPC

1. **API pública / de terceros.** Tus consumidores quieren `curl`, Postman,
   OpenAPI y poder probar desde el navegador. Publicar gRPC hacia afuera te
   convierte en el proveedor que nadie quiere integrar.
2. **Llamadas directas desde el navegador.** El browser no expone control
   suficiente sobre HTTP/2; necesitás **gRPC-Web** más un proxy que traduzca
   (Envoy). Es infraestructura extra para resolver algo que REST ya hace.
3. **Bajo volumen y payloads chicos.** A 40 req/s con mensajes de 500 bytes,
   la diferencia es irrelevante y **perdés debuggeabilidad**: no podés mirar
   un mensaje en un log ni reproducirlo con curl.
4. **Equipo o pipeline sin generación de código.** gRPC exige compilar
   `.proto` en CI, versionar y publicar stubs. Sin eso, los `.proto` se
   desincronizan y terminás con un contrato peor que un JSON honesto.

Bonus: **integraciones donde el otro lado manda** (un webhook de Stripe, un
partner). Ahí el protocolo lo elige el que paga.

### B5 — Cliente gRPC sin deadline

Paso a paso:

1. El default de gRPC sin deadline es **esperar indefinidamente**. La llamada
   no vuelve nunca por su cuenta.
2. La dependencia pasa de 50 ms a 40 s. Aplicá **Little**: si llegan 200
   req/s y `W` pasa de 0,05 s a 40 s, la concurrencia en vuelo pasa de
   `200 × 0,05 = 10` a `200 × 40 = **8.000** requests simultáneas`.
3. Esas 8.000 requests son objetos vivos en el heap del proceso Node:
   promesas, callbacks, buffers, contextos de tracing. **La memoria empieza a
   subir de forma lineal con el tiempo.**
4. Cada una probablemente **tiene tomada una conexión del pool de Postgres**
   o algún otro recurso escaso, adquirido antes de la llamada gRPC. El pool
   se agota → **endpoints que no tienen nada que ver con esta dependencia
   empiezan a fallar**. El fallo se propagó por un recurso compartido, no por
   la dependencia.
5. El heap crece → **el GC trabaja cada vez más** → pausas más largas → el
   event loop se traba → **sube el p99 de todo el proceso**.
6. Los clientes *aguas arriba* llegan a **su** timeout y **reintentan**, lo
   que agrega carga nueva sobre un sistema que ya no da abasto: la
   utilización efectiva pasa de 1,0 y la cola crece sin límite.
7. Kubernetes ve el `livenessProbe` fallar (el event loop no responde) y
   **mata el pod**. Sus 8.000 requests en vuelo se pierden y el tráfico va a
   los pods restantes, que caen por lo mismo, más rápido. **Cascada.**
8. Aunque la dependencia se recupere, el sistema **no vuelve solo**: la carga
   ahora incluye toda la avalancha de reintentos. Es un **fallo metaestable**
   (módulo 01, sección 5).

Con `deadline = 500 ms`: en el paso 2, `W` queda acotado en 0,5 s, la
concurrencia máxima es `200 × 0,5 = 100`, y el servicio **degrada** (devuelve
errores rápidos en ese endpoint) en vez de **colapsar** (se lleva puesto todo
el proceso). Es la diferencia entre un incidente de un endpoint y un
incidente de la plataforma.

> **Rúbrica bloque B**
> - **Mid:** sabe que protobuf es binario y que agregar campos es seguro.
> - **Senior:** explica el wire format (números, no nombres), acierta la
>   compatibilidad de tipos varint, y diagnostica el problema de L4 vs L7.
> - **Staff:** ve la corrupción **silenciosa** del caso (d), explica la cascada
>   de B5 con Little y nombra el fallo metaestable.

---

## Bloque C — Diseño aplicado

### C1 — `POST /orders` con 6 pasos

**(a) Clasificación, con el test de los 5 minutos:**

| | Paso | ¿5 min tarde? | Decisión |
| --- | --- | --- | --- |
| A | Validar stock | **Vender algo que no existe.** Grave | **Síncrono** |
| B | Cobrar | **Sin cobro no hay orden.** Grave | **Síncrono** (con matices, ver (c)) |
| C | Reservar envío | Se reserva 5 min después. Molesto, no grave | **Asíncrono** |
| D | Mail | Llega 5 min después. Normal | **Asíncrono** |
| E | Índice de búsqueda | Se indexa después. Irrelevante | **Asíncrono** |
| F | Analytics | Da igual | **Asíncrono** |

Matiz importante sobre C que conviene decir en voz alta: *"asíncrono
**siempre que haya stock verificado en A**. Si el envío es a una zona que
podría no tener cobertura, esa validación sube a síncrona — pero la
**reserva** sigue siendo asíncrona. Validar y ejecutar son cosas distintas, y
sólo la validación necesita estar en el camino crítico."* Esa separación es
una respuesta de nivel alto.

**(b) Techo de disponibilidad:** sólo A y B son duras → `0,999² = **99,80%**`
(86 min/mes) en vez de `0,999⁶ = 99,40%` (259 min/mes). **Sacar cuatro
dependencias del camino crítico te devolvió 173 minutos de disponibilidad
por mes sin que nadie mejore un solo servicio.** Ése es el argumento.

**(c) El cobro: proveedor externo, SLA 99,5%, p99 de 4 s.**

Ese 99,5% pone tu techo en `0,999 × 0,995 = **99,4%**` — 4,3 horas de caída
al mes, dominadas por alguien que no controlás. Y el p99 de 4 s hace que 1 de
cada 100 usuarios espere 4 segundos mirando un spinner.

El patrón correcto es el que usan casi todos los checkouts modernos:
**autorizar de forma asíncrona, confirmar por evento.**

```
POST /orders  (con Idempotency-Key)
  1. Valida stock (síncrono, rápido)
  2. RESERVA el stock (no lo descuenta: lo bloquea con TTL)
  3. Crea la orden en estado PENDING_PAYMENT
  4. Publica payment.requested (outbox, misma transacción)
  5. -> 202 Accepted { orderId, status: "processing" }     [~60 ms]

Worker de pagos
  - Llama al proveedor con Idempotency-Key = orderId
  - Reintentos con backoff + jitter (el 0,5% de caída suele ser transitorio)
  - Publica payment.succeeded | payment.failed

Al recibir payment.succeeded -> orden CONFIRMED, se confirma el stock,
  se disparan C/D/E/F.
Al recibir payment.failed     -> orden REJECTED, se libera la reserva.
El cliente ve el cambio de estado por WebSocket/SSE o polling.
```

Qué ganás: el 99,5% del proveedor **sale del camino crítico** (tu API
responde 202 aunque el proveedor esté caído), los reintentos con backoff
absorben su indisponibilidad transitoria, y el p99 de 4 s ya no lo espera el
usuario. Qué pagás: la orden tiene estados, el front tiene que manejarlos, y
necesitás idempotencia estricta (**cobrar dos veces es el peor bug posible en
este dominio**).

Cuándo **no** hacer esto: si el negocio exige "el usuario se va con el
producto en la mano ahora" (un POS físico, un ticket de acceso), la
confirmación tiene que ser síncrona y el diseño cambia. Preguntalo.

### C2 — Qué ve el usuario

```
t = 0 ms     clic en "Comprar"           -> botón deshabilitado, spinner
t = 60 ms    llega el 202                -> "¡Recibimos tu orden #A7X2!
                                            Estamos confirmando el pago."
                                            + se abre el canal SSE/WS
t = 1-6 s    llega payment.succeeded     -> "Pago confirmado ✅"
t = 8 s      llega shipment.reserved     -> "Envío reservado, llega el 14/9"
```

La clave de UX: **nunca dejes al usuario mirando un spinner sin información**.
Confirmar la *recepción* al instante y el *resultado* después es lo que hace
que lo asíncrono se sienta rápido. Y como el estado está persistido, si cierra
el navegador puede volver y ver la orden en el estado que corresponda.

**Si el pago sale bien y la reserva de envío falla 30 s después:**

Ya cobraste. **No podés simplemente "fallar".** Opciones, en orden de
preferencia:

1. **Reintentar** con backoff. La mayoría de los fallos son transitorios; en
   30 minutos de reintentos se resuelven casi todos, y el usuario no se
   entera de nada.
2. **Degradar**: confirmar la orden sin envío reservado y dejarla en
   `PENDING_SHIPMENT` para que un proceso (o un humano) la resuelva. En
   muchos negocios esto es perfectamente aceptable y es lo que se hace.
3. **Compensar** (si realmente no hay forma de cumplir): reembolso automático
   + notificación al usuario + liberación del stock.

Las tres son ramas de una **saga** (módulo 09): un flujo de larga duración
donde cada paso tiene su compensación, porque **no existe una transacción
distribuida que abarque a tu base y al proveedor de pagos**. Lo que nunca es
aceptable es la cuarta opción: cobrar y no hacer nada.

Y hay que decir lo incómodo en voz alta: la compensación **no es un rollback**.
El usuario ya vio el cobro en su resumen; el reembolso es un hecho nuevo, no
la anulación del anterior. Diseñar sagas es diseñar qué le contás al usuario
en cada rama.

### C3 — 40.000 eventos acumulados

Cuando el consumer arranca, lee desde el último offset commiteado y procesa
**a máxima velocidad**. Tres cosas que salen mal si nadie lo pensó:

1. **El consumer se tumba a sí mismo o a su base.** Pasa de 50 msg/s a
   2.000 msg/s de golpe. Ese pico de escrituras satura el pool de Postgres,
   dispara los timeouts, los mensajes fallan, se reintentan... y **el consumer
   recién recuperado se cae de nuevo**. Se arregla con `max.poll.records`
   acotado, rate limiting en el consumer, o escalado gradual. Contraintuitivo
   pero cierto: **después de una caída conviene drenar despacio, no rápido.**
2. **Efectos secundarios masivos y absurdos.** 40.000 eventos → 40.000 mails.
   El usuario que compró hace 3 horas recibe ahora "tu envío está reservado",
   junto con otros 39.999. Peor si hay push notifications. Hace falta lógica
   de **relevancia temporal**: eventos vencidos que se descartan o se agrupan
   (`if (evento.timestamp < ahora - 1h) → sólo persistir, no notificar`).
3. **Rebalance en loop.** Si procesar el batch tarda más que
   `max.poll.interval.ms` (5 min por defecto), Kafka considera muerto al
   consumer, dispara un **rebalance**, otro consumer toma la partición desde
   el último offset commiteado y **reprocesa los mismos mensajes**, tarda lo
   mismo, y vuelve a ser expulsado. El consumer group entra en un ciclo de
   rebalances donde **nunca avanza** y reprocesa lo mismo eternamente.

Cuarto problema, más sutil: si los eventos son de estado (`OrderUpdated`) y
se reprocesan sin control de versión, podés **pisar estado nuevo con estado
viejo**. Hace falta un chequeo de versión/timestamp en el handler.

Todo esto es exactamente por qué los handlers tienen que ser **idempotentes**
(módulo 06) y por qué hay que **medir y alertar sobre el consumer lag**
(módulo 10).

### C4 — `save()` y después `emit()`, y el proceso se muere en el medio

- **(a) Estado:** la orden **existe en la base** y el evento **no se publicó
  nunca**. El envío no se reserva, el mail no sale, el índice no se actualiza.
  Y no hay nada que lo vuelva a intentar: el evento no existe en ningún lado.
  **Es una inconsistencia permanente y silenciosa.**
- **(b) Cómo lo detectás:** casi nunca en el momento — ése es el problema.
  Lo detectás con un **job de reconciliación** que compara los dos lados
  (`órdenes CONFIRMED sin envío asociado con más de X minutos de antigüedad`)
  y alerta. En la práctica, si no lo tenés, lo detecta un cliente por soporte.
  Que la respuesta a "¿cómo lo detectás?" sea incómoda es justamente lo que
  hace que valga la pena prevenirlo.
- **(c) Cómo lo prevenís: patrón `outbox` (transactional outbox).**
  ```sql
  BEGIN;
    INSERT INTO orders (...);
    INSERT INTO outbox (id, topic, payload, created_at) VALUES (...);
  COMMIT;
  ```
  Las dos escrituras van en **la misma transacción de la misma base**: o
  quedan las dos o no queda ninguna. Un proceso aparte (un poller, o
  **Debezium** leyendo el WAL con CDC) lee la tabla `outbox` y publica en
  Kafka. Si el proceso se muere, el evento sigue en la tabla y se publica
  cuando vuelva.
  El costo: la entrega pasa a ser **at-least-once** (el publicador puede
  morir después de publicar y antes de marcar la fila como enviada, y
  republica). Por eso el outbox **exige** consumidores idempotentes: los dos
  patrones vienen siempre juntos.
- **(d) ¿Meter el `emit()` dentro de la transacción?** **No, no resuelve
  nada.** La transacción es de Postgres; Kafka no participa de ella. Si
  publicás dentro del `BEGIN...COMMIT` y después el `COMMIT` falla, tenés el
  problema **espejo y peor**: publicaste un evento sobre una orden que **no
  existe**, y los consumidores van a procesar algo fantasma. Cambiaste
  "evento perdido" por "evento fantasma".
  Lo único que resolvería el problema de raíz es una transacción distribuida
  con **2PC** entre Postgres y Kafka — que Kafka no soporta de esa forma, y
  que de todos modos es una mala idea (bloqueante, frágil, y con el
  coordinador como punto único de falla). **La respuesta real de la industria
  a este problema es el outbox, no 2PC.**

> **Rúbrica bloque C**
> - **Mid:** clasifica bien sync/async y conoce el outbox de nombre.
> - **Senior:** justifica cada decisión con el test de los 5 minutos, calcula
>   el techo de disponibilidad, y sabe por qué el emit dentro de la transacción no sirve.
> - **Staff:** separa validar de ejecutar, diseña los estados de la orden y qué
>   ve el usuario en cada rama, y ve el problema del "drenar rápido" post-caída.

---

## Bloque D — Abierto

### D1 — "Partamos el monolito en 12 servicios en 6 meses"

**Lo que pregunto primero** (y el orden importa, porque va de negocio a
técnica):

1. **¿Qué problema estamos resolviendo?** Las razones válidas son concretas:
   "3 equipos se pisan en el mismo deploy", "el módulo de reportes consume
   toda la CPU y afecta al checkout", "necesitamos escalar X 10 veces y el
   resto no". Las inválidas: "es lo moderno", "así escala".
2. **¿Cuáles son los límites del dominio?** Si no podemos nombrar los
   *bounded contexts* con confianza, no estamos listos para cortar. **Cortar
   mal es mucho peor que no cortar**: mover un límite entre dos servicios
   cuesta 10 veces más que moverlo entre dos módulos.
3. **¿Tenemos la plataforma?** CI/CD por servicio, tracing distribuido,
   logging centralizado, service discovery, gestión de secretos, entorno
   local que no requiera levantar 12 servicios. Sin esto, 12 servicios son
   12 problemas nuevos y cero beneficios.
4. **¿Cómo se parten los datos?** Es el 80% del trabajo real y el que nadie
   estima. ¿Qué pasa con los `JOIN` que hoy son gratis y mañana son 3
   llamadas de red?

**Lo que propongo:** el patrón **strangler fig**. Nada de "big bang" a 6
meses. Se elige **un** contexto —el que más duele, con el límite más claro y
la menor cantidad de joins con el resto— y se extrae **completo**: código,
datos, deploy, ownership. Se mide (¿mejoró el tiempo de deploy?, ¿bajó la
coordinación?, ¿mejoró la latencia?) y **recién entonces** se decide el
siguiente. Módulo primero, servicio después: si no podés separarlo en módulos
con límites limpios dentro del monolito, tampoco vas a poder separarlo en
servicios.

**Los riesgos concretos que nombro:**

- **El riesgo #1: terminar en un monolito distribuido.** Doce servicios que
  hay que deployar juntos, con la misma base compartida. Es el desenlace
  *estadísticamente más probable* de un big-bang a 6 meses, y deja al equipo
  peor que como empezó.
- **Seis meses sin entregar valor de negocio.** Es el plazo en que se cancela
  la migración a mitad de camino, y ahí queda el peor de los mundos: medio
  monolito, medio microservicios, el doble de superficie operativa.
- **Los joins que desaparecen.** Una query que hoy es un `JOIN` de 5 ms
  mañana son 3 llamadas de red, un problema de N+1 distribuido y una
  consistencia que hay que razonar a mano.
- **Disponibilidad compuesta** (módulo 01): 12 servicios sincrónicos de
  99,9% son 98,8% — **8,6 horas de caída al mes**. La migración puede
  empeorar la disponibilidad si nadie hace ese cálculo antes.

Y la cita que conviene tener a mano, de Fowler: *casi todos los casos
exitosos de microservicios empezaron con un monolito que se volvió demasiado
grande y se fue partiendo; casi todos los casos que empezaron directo en
microservicios terminaron en problemas serios.*

### D2 — Comunicación de un sistema de agentes de IA

```
┌─────────┐  1. POST /messages (Idempotency-Key)     ┌──────────────┐
│ Cliente │ ───────────────────────────────────────► │  API NestJS  │
│         │ ◄─────────  202 { messageId }  ────────  │              │
│         │                                          └──────┬───────┘
│         │  2. GET /messages/:id/stream (SSE)              │ publica
│         │ ◄══════════ tokens en vivo ═══════════╗         ▼
└─────────┘                                       ║  ┌────────────┐
                                                  ║  │   Kafka    │
   ┌──────────────────────────────────────────────╨──┴─────┬──────┘
   │  Redis pub/sub (fan-out de tokens al pod correcto)     │
   └───────────────────────────────┬────────────────────────┘
                                   │
                          ┌────────▼─────────┐
                          │  Worker/Agente   │
                          │  bucle ReAct     │
                          └───┬──────────┬───┘
                     gRPC     │          │  gRPC (deadline!)
                  ┌───────────▼──┐  ┌────▼──────────┐
                  │ Herramienta A│  │ Herramienta B │
                  └──────────────┘  └───────────────┘
```

**Qué es síncrono y qué asíncrono:**

- **Asíncrono**: la entrada del usuario. `POST` → persistir → publicar evento
  → `202` en ~30 ms. Motivo duro: la generación tarda 3-40 s y **API Gateway
  corta a los 29 s** (módulo 01, C4). No es una preferencia, es un límite.
- **Síncrono (gRPC, con deadline)**: las llamadas del agente a las
  herramientas. El agente **necesita** el resultado para decidir el paso
  siguiente — es el bucle ReAct, no hay forma de que sea asíncrono. Deadline
  obligatorio y proporcional: una herramienta que tarda más que lo que queda
  del presupuesto de tiempo total no debería ni empezar.
- **Asíncrono (streaming)**: la salida hacia el usuario. SSE o WebSocket.
- **Asíncrono**: persistencia de la traza, métricas de tokens y costo, evals.
  Nada de eso puede bloquear la respuesta.

**Cómo le llegan los tokens al usuario:** el worker que corre el agente
**no es el mismo proceso** que mantiene la conexión SSE del usuario. Se
resuelve con un canal de fan-out: el worker publica los tokens en
`Redis pub/sub` sobre el canal `stream:{messageId}`, y el pod de API que
tiene la conexión abierta está suscrito y los reenvía. Además se guarda un
buffer de los tokens ya emitidos (Redis Stream con TTL), para poder
**reanudar** desde donde se cortó.

Detalle que vale oro y casi nadie menciona: **el time-to-first-token es la
métrica de UX, no la latencia total**. 40 segundos con tokens saliendo desde
los 500 ms se sienten aceptables; 8 segundos de spinner mudo no.

**Si el usuario cierra el navegador a los 5 segundos:** **el trabajo sigue.**
Está en Kafka, no en la conexión HTTP. El agente termina, persiste la
respuesta completa, y cuando el usuario vuelve la ve en el historial. Ese es
precisamente el beneficio de haberlo desacoplado: **el trabajo no vive en la
conexión del usuario**.

Lo cual abre la pregunta de negocio correcta: *¿queremos que siga?* Si el
usuario abandonó, terminar la generación **cuesta tokens reales**. Un diseño
maduro emite un `cancellation` cuando la conexión se cierra Y no hay
reconexión en N segundos, y el worker chequea la cancelación entre pasos del
bucle. Nombrar el costo en dólares de esa decisión es lo que distingue una
respuesta de arquitecto.

**Si el mismo mensaje se procesa dos veces** (y se va a procesar: Kafka es
at-least-once):

- Sin protección: **dos llamadas al LLM (pagás dos veces), dos ejecuciones de
  las herramientas** — y si alguna herramienta tiene efecto (mandar un mail,
  crear un ticket, mover plata), **ese efecto se duplica**. En un sistema de
  agentes ésta es la falla más cara que existe, porque los efectos son reales
  y el costo es en dólares.
- Con protección, en tres capas:
  1. **`Idempotency-Key` en el ingreso**: el mismo request HTTP devuelve el
     mismo `messageId` sin crear trabajo nuevo (módulo 13).
  2. **Deduplicación en el consumer**: tabla/`SETNX` en Redis con el
     `messageId` y estado; si ya está `COMPLETED`, se descarta.
  3. **Idempotencia en cada tool-call**: cada llamada a herramienta lleva su
     propia clave derivada determinísticamente
     (`hash(messageId + stepIndex + toolName + args)`). Así, si el bucle se
     reanuda desde el paso 3, los pasos 1 y 2 **no se re-ejecutan**: se
     recuperan del registro. Esto convierte el bucle del agente en algo
     **reanudable**, que es lo que querés cuando un paso tarda 40 s y el pod
     se puede reciclar en el medio.

Ese tercer punto es, en el fondo, el mismo problema que resuelve un motor de
workflows durables (Temporal, Step Functions): **persistir cada paso para
poder retomar sin repetir efectos**. Nombrarlo así muestra que ves el patrón
general y no sólo el caso.

Todo esto es el módulo 14. Si esta respuesta te salió razonablemente
completa, ya tenés la arquitectura mental armada y ese módulo te va a servir
para afinar detalles, no para aprender el concepto.

> **Rúbrica bloque D**
> - **Mid:** propone el strangler fig y sabe que hay que hacer streaming.
> - **Senior:** pregunta por los bounded contexts y la plataforma antes de
>   opinar; separa el canal de tokens del proceso que genera; nombra idempotencia.
> - **Staff:** cuantifica el riesgo (disponibilidad compuesta, costo en dólares
>   de la doble ejecución), diseña la reanudación del bucle y trae la decisión
>   de negocio (¿cancelamos si el usuario se fue?).

---

## Fuentes para profundizar

- **Sam Newman**, *Building Microservices* (2ª ed.), caps. 4-5.
- **gRPC Core Concepts** — deadlines, tipos de RPC, códigos de estado:
  <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC Load Balancing** (blog oficial) — el problema de L4 vs L7:
  <https://grpc.io/blog/grpc-load-balancing/>
- **Protobuf**, *Encoding* y *Updating a Message Type*:
  <https://protobuf.dev/programming-guides/encoding/> ·
  <https://protobuf.dev/programming-guides/proto3/#updating>
- **Chris Richardson**, patrones *Transactional Outbox* y *Saga*:
  <https://microservices.io/patterns/data/transactional-outbox.html>
- **Martin Fowler**, *MonolithFirst* y *StranglerFigApplication*:
  <https://martinfowler.com/bliki/MonolithFirst.html>
- **NestJS Microservices** — `send` vs `emit`, transporte gRPC y Kafka:
  <https://docs.nestjs.com/microservices/basics>

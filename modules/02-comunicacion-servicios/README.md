# Módulo 02 — Comunicación entre servicios

## Por qué acá

En el módulo 01 apareció un número incómodo: si tu servicio depende
sincrónicamente de 5 servicios de 99,9%, tu techo es 99,5% — **2,2 horas de
caída al mes aunque tu código sea perfecto**. Y el fan-out convertía el p99
de tus dependencias en el caso común del usuario.

Los dos problemas tienen la misma raíz: **cómo se hablan los servicios**.
Este módulo es la decisión de arquitectura que más impacto tiene en un
sistema de microservicios, y la que más se pregunta en entrevistas: *"¿por
qué acá usaste una cola y allá una llamada gRPC?"*.

La respuesta mala es "porque es más escalable". La buena tiene un número.

## Teoría mínima

### 1. El eje que importa: acoplamiento temporal

Olvidate por un momento de REST/gRPC/Kafka. La pregunta de fondo es una sola:

> **¿El emisor necesita que el receptor esté vivo *ahora* para que la
> operación tenga éxito?**

- **Sí** → comunicación **síncrona**. Acoplamiento temporal. Si el receptor
  está caído, tu operación falla.
- **No** → comunicación **asíncrona**. El mensaje espera en algún lado. Si el
  receptor está caído, se procesa cuando vuelva.

Todo lo demás (protocolo, formato, librería) es un detalle de implementación
comparado con esta decisión.

Ojo con una confusión muy común: **asíncrono ≠ `async/await`**. Un
`await this.userClient.getUser(id)` es una llamada **síncrona** desde el punto
de vista arquitectónico, por más que el código use `async`. Lo que la hace
síncrona es que la operación no puede completarse sin la respuesta.

### 2. Qué se multiplica y qué se suma

| | Cadena síncrona | Flujo asíncrono |
| --- | --- | --- |
| **Disponibilidad** | Se **multiplica**: `0,999⁵ = 99,5%` | Se aísla: sólo depende del broker |
| **Latencia** | Se **suma** (secuencial) o toma el máximo (paralelo) | El emisor no la ve |
| **Fallo del receptor** | Falla tu request | El mensaje espera en la cola |
| **Presión (backpressure)** | Se propaga hacia atrás y te tumba | La cola la absorbe, y la medís (lag) |
| **A cambio, pagás** | — | Consistencia eventual, duplicados, orden, debugging más difícil |

Esa última fila es la clave y es lo que un candidato mid nunca menciona. Lo
asíncrono **no es gratis**: te da disponibilidad y te cobra en complejidad.
El sistema pasa de "funcionó o falló" a "va a funcionar en algún momento,
posiblemente más de una vez, posiblemente fuera de orden".

De ahí salen los tres módulos siguientes de esta fase: idempotencia
(módulo 06), Kafka y orden (07), y outbox/saga (09). **No podés hacer
asíncrono bien sin esos tres.**

### 3. Cuándo síncrono y cuándo asíncrono

Usá **síncrono** cuando:

- El que llama **necesita el resultado para continuar** (validar un token,
  chequear stock antes de confirmar, obtener el precio).
- La operación es una **consulta** (un read).
- La respuesta cambia lo que le mostrás al usuario **ahora**.

Usá **asíncrono** cuando:

- El que llama **no necesita el resultado** (mandar el mail, indexar en
  Elasticsearch, actualizar analytics, generar el thumbnail).
- La operación es **lenta o de latencia impredecible** (llamar a un LLM,
  procesar un video, hablar con un proveedor externo).
- Hay **muchos interesados** en el mismo hecho (un `OrderCreated` que le
  importa a facturación, a logística, a notificaciones y a analytics).
- Necesitás **absorber picos** (el caso del broadcast del módulo 01: 42.000/s
  de entrada, 600/s que acepta el proveedor).

La heurística práctica, la que conviene decir en una entrevista:

> **"¿Qué pasa si esto tarda 5 minutos en ocurrir? Si la respuesta es 'nada
> grave', sacalo del camino crítico."**

### 4. El menú de protocolos

| | REST/JSON | gRPC | GraphQL | Mensajería (Kafka/SQS) |
| --- | --- | --- | --- | --- |
| **Acoplamiento** | Síncrono | Síncrono | Síncrono | Asíncrono |
| **Contrato** | OpenAPI (opcional, se pudre) | **Protobuf (obligatorio, compilado)** | Schema (obligatorio) | Schema Registry (Avro/Protobuf) |
| **Payload** | Texto, verboso | Binario, compacto (3-10x menor) | Texto | Según formato |
| **Transporte** | HTTP/1.1 o 2 | **HTTP/2 obligatorio** (multiplexado) | HTTP | TCP propio |
| **Streaming** | SSE / chunked | **Nativo, bidireccional** | Subscriptions | Nativo por diseño |
| **Debuggeable con curl** | ✅ | ❌ (necesitás `grpcurl`) | ~ | ❌ |
| **Navegador** | ✅ | Requiere gRPC-Web + proxy | ✅ | ❌ |
| **Mejor para** | APIs públicas, integraciones | **Servicio ↔ servicio interno** | BFF, clientes con necesidades distintas | Eventos, desacople, picos |

La regla que aplica al 90% de los casos, y que probablemente ya usás:
**gRPC hacia adentro, REST hacia afuera, eventos para lo que no bloquea.**

### 5. gRPC en serio (lo que se pregunta)

**Por qué es más rápido:**

1. **Protobuf en vez de JSON.** El schema está compilado de los dos lados, así
   que el mensaje no lleva los nombres de los campos: lleva **números de campo
   en varint**. Un `{"userId": 12345}` de 19 bytes se convierte en 3-4 bytes.
   Además parsear binario es mucho más barato que parsear texto — y en Node,
   donde el parseo bloquea el event loop, eso importa el doble.
2. **HTTP/2 multiplexado.** Muchas llamadas concurrentes viajan por **una
   sola conexión TCP**, sin head-of-line blocking a nivel HTTP y sin abrir
   sockets nuevos. Con HTTP/1.1 tenés un pool de conexiones y un límite de
   requests en vuelo por conexión.
3. **Headers comprimidos (HPACK)** y conexión persistente: no repetís
   metadata en cada llamada.

**Los cuatro conceptos que hay que saber nombrar:**

- **Deadlines, no timeouts.** En gRPC el cliente manda un *deadline absoluto*
  que **se propaga por toda la cadena de llamadas**. Si A le da 500 ms a B, y
  B tarda 400 ms antes de llamar a C, C recibe un deadline de 100 ms — y
  puede cortar antes de empezar trabajo inútil. Un timeout local no se
  propaga; un deadline sí. **Siempre poné deadline: sin deadline, una llamada
  gRPC espera para siempre**, y ese es el origen clásico del agotamiento de
  pool y del colapso metaestable del módulo 01.
- **Los 4 tipos de RPC:** unario, server-streaming (el server manda muchos:
  ideal para tokens de un LLM), client-streaming, bidireccional.
- **El problema de load balancing.** gRPC mantiene **conexiones persistentes**,
  y un balanceador de capa 4 (NLB, `ClusterIP` de Kubernetes) balancea
  *conexiones*, no *requests*. Resultado: la conexión se pega a un pod y todo
  el tráfico de ese cliente va siempre al mismo, mientras los pods nuevos que
  levanta el autoscaler quedan **vacíos**. Es un bug clásico de producción y
  una pregunta de entrevista frecuente. Se resuelve con balanceo L7 (ALB con
  soporte gRPC, Envoy/Istio, o `linkerd`) o con client-side load balancing
  (resolución DNS por headless service + política round-robin en el cliente).
- **Códigos de estado y reintentos.** `UNAVAILABLE` y `DEADLINE_EXCEEDED` son
  reintentables; `INVALID_ARGUMENT` y `FAILED_PRECONDITION` **no** (reintentar
  sólo gasta). Y reintentar sólo es seguro si la operación es idempotente
  (módulo 06).

### 6. Contratos: lo único que realmente te acopla

Los servicios no se acoplan por el protocolo. Se acoplan por el **contrato**.
Y el contrato se rompe en deploys, no en diseños.

**Reglas de evolución en Protobuf** (valen casi igual para Avro y para JSON):

```protobuf
message User {
  string id = 1;
  string email = 2;
  // string nombre = 3;      <-- BORRADO
  reserved 3;                 // <-- NUNCA reutilizar el número 3
  reserved "nombre";
  string full_name = 4;       // el campo nuevo va con número nuevo
}
```

- ✅ **Seguro:** agregar campos nuevos con números nuevos; agregar valores
  nuevos a un enum (con cuidado en el consumidor); renombrar un campo (el
  nombre no viaja, viaja el número).
- ❌ **Rompe todo:** cambiar el **número** de un campo, cambiar el **tipo**
  de un campo, **reutilizar** un número borrado (el consumidor viejo va a
  leer datos nuevos con el significado viejo — corrupción silenciosa, sin
  error, la peor clase de bug).
- 🔑 **`reserved` no es opcional.** Es lo que impide que alguien, en dos años,
  reutilice el número 3 sin saberlo.

**Compatibilidad hacia atrás y hacia adelante:**
- *Backward compatible*: un consumidor **nuevo** puede leer datos **viejos**.
- *Forward compatible*: un consumidor **viejo** puede leer datos **nuevos**
  (ignora los campos que no conoce — protobuf hace esto por diseño).

Necesitás **las dos** si deployás sin downtime, porque durante un rolling
update conviven versiones viejas y nuevas del mismo servicio, en las dos
direcciones. De ahí sale la regla de oro:

> **Nunca hagas un cambio incompatible en un solo deploy.** Se hace en tres
> pasos: (1) agregar el campo nuevo, deployar todo; (2) migrar a los
> consumidores al campo nuevo, deployar todo; (3) recién ahí borrar el viejo
> y marcarlo `reserved`. Se llama *expand / migrate / contract*.

### 7. El anti-patrón: el monolito distribuido

El fracaso más común de los microservicios. Señales:

- Para agregar una feature hay que **deployar 4 servicios juntos y en orden**.
- Un request de usuario cruza **6 servicios sincrónicamente**.
- Los servicios **comparten la misma base de datos** (o peor: las mismas
  tablas).
- Si un servicio se cae, se cae todo.

Tenés todos los costos de lo distribuido (red, latencia, fallos parciales,
debugging, deploys coordinados) y ninguno de los beneficios (deploy
independiente, aislamiento de fallos, escalado independiente).

El test rápido, y una respuesta excelente cuando preguntan "¿cómo sabés si
tus microservicios están mal cortados?":

> **"¿Puedo deployar este servicio un viernes a las 6 de la tarde sin
> coordinar con nadie? Si la respuesta es no, no es un microservicio: es un
> módulo del monolito, con latencia de red agregada."**

El corte correcto no es técnico (un servicio por tabla) sino de dominio: por
**capacidad de negocio**, siguiendo el criterio de que lo que cambia junto
vive junto (alta cohesión) y lo que cambia por separado se separa (bajo
acoplamiento). Ahí es donde entra DDD y los *bounded contexts*.

### 8. Aplicado a tu stack (NestJS)

NestJS abstrae los transportes con `@nestjs/microservices`, y esa abstracción
tiene una trampa que conviene tener clara:

```ts
// SÍNCRONO — espera respuesta. Acopla temporalmente.
// Cambiar el transporte a Kafka NO lo hace asíncrono: sigue esperando.
const user = await firstValueFrom(this.client.send('user.get', { id }));

// ASÍNCRONO — dispara y sigue. No espera nada.
this.client.emit('order.created', { orderId });
```

- `send()` = *request/response* → acoplamiento temporal, **aunque el
  transporte sea Kafka**. Nest crea un topic de respuesta y espera. Es el
  error conceptual más frecuente: *"usamos Kafka, así que es asíncrono"* —
  no, si usás `send()`, es RPC sobre Kafka, y con peor latencia que gRPC.
- `emit()` = *event* → sin acoplamiento temporal. Esto sí es asíncrono.
- **Ojo con `emit()` a secas:** si publicás el evento *después* de commitear
  en la base y el proceso se muere en el medio, el evento se pierde para
  siempre y quedás inconsistente. La solución es el patrón **outbox**
  (módulo 09): escribís el evento en una tabla, **en la misma transacción**,
  y un proceso aparte lo publica.
- **Deadlines en gRPC con Nest:** hay que pasarlos explícitamente por
  metadata; no vienen por defecto. Un cliente gRPC sin deadline es una fuga
  de recursos esperando a ocurrir.

## Lo que vas a correr

Sin dependencias. Node >= 22.18:

```bash
node modules/02-comunicacion-servicios/cadena-sincrona.ts
node modules/02-comunicacion-servicios/proto-vs-json.ts
```

1. **`cadena-sincrona.ts`** — simula el mismo caso de negocio con tres
   arquitecturas (cadena síncrona, paralelo con degradación, asíncrona con
   cola) y mide disponibilidad efectiva, latencia p99 y qué pasa cuando una
   dependencia se degrada. Es el módulo 01 aplicado a una decisión concreta.
2. **`evolucion-contrato.ts`** — decodifica los mismos bytes con cinco
   schemas distintos de consumidor y muestra cuál sobrevive y cuál corrompe
   los datos sin lanzar ningún error.
3. **`outbox-polling.ts`** — el publisher del outbox: latencia, queries/s
   contra la base y el techo `lote / intervalo`.
4. **`dual-write.ts`** — cuántas órdenes por día quedan rotas con cada
   diseño de doble escritura. La respuesta no es "casi ninguna".
5. **`proto-vs-json.ts`** — implementa un encoder de Protobuf mínimo (varint
   + campos con longitud) desde cero, y compara tamaño y tiempo de
   serialización contra JSON sobre el mismo mensaje. Escribir el varint a
   mano es la manera más rápida de entender por qué protobuf es chico y por
   qué **el número de campo importa y el nombre no**.

## Para pensar / próximo paso

- Tenés `POST /orders` que: valida stock (servicio A), cobra (servicio B),
  reserva envío (servicio C) y manda un mail (servicio D). ¿Cuáles van
  sincrónicos y cuáles asíncronos? ¿Qué pasa si el cobro sale bien pero la
  reserva de envío falla? *(Spoiler: eso es una saga — módulo 09.)*
- Si pasás la notificación a asíncrona, **¿cómo le decís al usuario que la
  orden se creó bien?** ¿Y si el evento se procesa dos veces?
- Un servicio publica `OrderCreated` y otro lo consume. Deployás una versión
  nueva del productor que agrega un campo. ¿Se rompe algo? ¿Y si en vez de
  agregar, **renombrás** el campo? ¿Y si cambiás el tipo de `int32` a `int64`?

Las tres están resueltas —con código, no con prosa— en
[`para-pensar.md`](para-pensar.md), que además trae un apéndice sobre **cómo
funciona el outbox por dentro** (polling vs `LISTEN/NOTIFY` vs CDC, y por qué
el índice parcial es lo que evita saturar la base).

Y sobre el outbox hay dos documentos más:
[`outbox-cuando.md`](outbox-cuando.md) — **cuándo hace falta y cuándo no**, y
por qué no reemplaza a la saga — y
[`outbox-brokers.md`](outbox-brokers.md) — **qué cambia con Kafka, RabbitMQ o
Redis Streams**, y en qué se diferencia de *"llega un evento y lo guardo en la
base"*. Intentalas antes de abrirlo, y para la
tercera corré `evolucion-contrato.ts`: vas a ver la corrupción silenciosa
ocurrir sin que se lance ni un error.

## Fuentes

- **Sam Newman**, *Building Microservices* (2ª ed.), caps. 4-5 — comunicación
  y contratos. Es el libro de referencia sobre este módulo.
- **gRPC**, guía de conceptos básicos y deadlines:
  <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC blog**, *gRPC Load Balancing* — el problema de L4 vs L7:
  <https://grpc.io/blog/grpc-load-balancing/>
- **Protocol Buffers**, encoding y reglas de evolución:
  <https://protobuf.dev/programming-guides/encoding/> y
  <https://protobuf.dev/programming-guides/proto3/#updating>
- **Martin Fowler**, *MonolithFirst* y *Microservice Trade-Offs*:
  <https://martinfowler.com/bliki/MicroservicePremium.html>
- **NestJS Microservices**, `send` vs `emit`:
  <https://docs.nestjs.com/microservices/basics>

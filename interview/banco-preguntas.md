# Banco de preguntas de entrevista

Preguntas ordenadas por dificultad y por lo que evalúan. La columna
**"Módulo"** dice qué parte del path necesitás tener andando para responderla
bien — si todavía no llegaste, anotala y volvé.

Marcá con ✅ las que ya practicaste **cronometradas y en voz alta**. Leerlas
y pensar "sí, más o menos sé" no cuenta: en la entrevista hay que producirlo
hablando, en 45 minutos, con alguien interrumpiendo.

---

## 1. Diseño de sistemas clásicos

Son los "grandes éxitos". Aparecen literalmente en entrevistas de producto y
de infra, y cada uno esconde **un** concepto central.

| ✅ | Pregunta | El concepto que realmente evalúa | Módulo |
| --- | --- | --- | --- |
| ☐ | Diseñá un **acortador de URLs** (tipo bit.ly) | Generación de IDs sin colisión, ratio lectura/escritura extremo, caché | 01, 04, 05 |
| ☐ | Diseñá un **rate limiter** distribuido | Algoritmos (token bucket vs sliding window), estado compartido, race conditions | 04, 06, 12 |
| ☐ | Diseñá un **sistema de notificaciones** | Fan-out, colas por prioridad, rate limit de proveedores, idempotencia | 02, 07, 08 |
| ☐ | Diseñá un **chat** (tipo WhatsApp) | Conexiones persistentes, presencia, orden de mensajes, entrega garantizada | 02, 06, 07 |
| ☐ | Diseñá el **feed** de una red social | Fan-out on write vs on read, el problema de las celebridades, caché | 03, 04, 05 |
| ☐ | Diseñá un **sistema de búsqueda** con autocompletado | Estructuras de datos (trie), índices invertidos, latencia sub-100 ms | 03, 04 |
| ☐ | Diseñá **Google Drive / Dropbox** | Chunking, deduplicación, sincronización, resolución de conflictos | 05, 06 |
| ☐ | Diseñá un **sistema de reservas** (hoteles, vuelos, entradas) | **Consistencia fuerte**, doble booking, locks, inventario | 05, 06 |
| ☐ | Diseñá **Uber / delivery** (matching en tiempo real) | Geoespacial, actualizaciones de alta frecuencia, matching | 03, 05, 07 |
| ☐ | Diseñá un **procesador de pagos** | Idempotencia estricta, sagas, auditoría, reconciliación | 06, 09, 13 |
| ☐ | Diseñá **YouTube / streaming de video** | Pipeline de encoding, CDN, storage masivo, colas de trabajo | 03, 07, 11 |
| ☐ | Diseñá un **sistema de métricas** (tipo Datadog) | Series temporales, agregación, cardinalidad, retención por resolución | 07, 10 |

---

## 2. Preguntas sobre tu stack

Éstas son las que te van a hacer **a vos**, porque están en tu CV. Se
responden con experiencia concreta, no con teoría — y ahí es donde un senior
tiene ventaja sobre alguien que estudió un libro.

### Microservicios y NestJS

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | ¿Cómo decidís los límites de un microservicio? ¿Cuándo NO partirías? | 02 |
| ☐ | Contame de un microservicio que hayas cortado mal. ¿Cómo te diste cuenta? | 02 |
| ☐ | ¿Cómo manejás transacciones que cruzan varios servicios? | 09 |
| ☐ | ¿Cómo compartís tipos/contratos entre servicios sin acoplarlos? | 02 |
| ☐ | Un endpoint tiene p50 de 12 ms y p99 de 3 s. ¿Cómo lo diagnosticás? | 01, 10 |
| ☐ | ¿Cómo hacés un deploy sin downtime con un cambio de esquema? | 05, 13 |
| ☐ | Node es single-threaded. ¿Cómo afecta eso al diseño de tus servicios? | 01, 03 |

### gRPC

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | ¿Por qué gRPC y no REST? ¿Dónde NO lo usarías? | 02 |
| ☐ | Diferencia entre timeout y deadline. ¿Por qué importa en una cadena? | 02 |
| ☐ | Tenés un servicio gRPC en k8s y los pods nuevos no reciben tráfico. ¿Por qué? | 02 |
| ☐ | ¿Cómo evolucionás un `.proto` sin romper consumidores? | 02 |
| ☐ | ¿Cómo manejás errores y reintentos en gRPC? ¿Qué códigos son reintentables? | 02, 08 |

### Kafka

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | ¿Cómo elegís la cantidad de particiones? ¿Qué pasa si te quedás corto? | 07 |
| ☐ | ¿Cómo garantizás el orden de los mensajes? ¿Qué perdés a cambio? | 07 |
| ☐ | El consumer lag crece. ¿Cómo lo diagnosticás y qué opciones tenés? | 07, 01 |
| ☐ | Diferencia entre at-least-once, at-most-once y exactly-once. ¿Existe el tercero? | 06, 07 |
| ☐ | ¿Qué pasa durante un rebalance? ¿Cómo evitás el loop de rebalances? | 07 |
| ☐ | Kafka vs SQS vs RabbitMQ vs EventBridge: ¿cuándo cada uno? | 07, 11 |
| ☐ | ¿Cómo manejás un mensaje que falla siempre (poison pill)? | 08 |

### Redis y caching

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | Cache-aside vs write-through vs write-behind: ¿cuándo cada uno? | 04 |
| ☐ | ¿Cómo invalidás caché de forma confiable? | 04 |
| ☐ | ¿Qué es un cache stampede y cómo lo evitás? | 04 |
| ☐ | Se cae Redis. ¿Qué pasa con tu sistema? ¿La base aguanta el 100%? | 04, 08 |
| ☐ | ¿Cómo implementás un lock distribuido? ¿Por qué Redlock es controvertido? | 06 |
| ☐ | ¿Cómo elegís el TTL? ¿Por qué agregarle jitter? | 04 |

### Idempotencia (tu tema — esperá preguntas profundas acá)

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | ¿Qué es una operación idempotente? Dame un ejemplo de una que parece serlo y no lo es | 06 |
| ☐ | Diseñá idempotencia para `POST /payments`. ¿Dónde vive la clave? ¿Cuánto dura? | 06, 13 |
| ☐ | Dos requests con la misma Idempotency-Key llegan **al mismo tiempo**. ¿Qué pasa? | 06 |
| ☐ | ¿Qué devolvés ante una clave repetida: la respuesta original, un 409, o un 200 vacío? | 13 |
| ☐ | El primer request falló a la mitad. Llega el reintento. ¿Qué hacés? | 06, 09 |
| ☐ | ¿Cómo hacés idempotente un consumer de Kafka? ¿Y si el efecto es llamar a una API externa? | 06, 07 |

### AWS

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | ECS vs EKS vs Lambda: ¿cómo elegís? | 11 |
| ☐ | RDS vs Aurora vs DynamoDB: ¿cuándo cada uno? | 05, 11 |
| ☐ | SQS vs SNS vs EventBridge vs MSK | 07, 11 |
| ☐ | ¿Cómo diseñás para tolerar la caída de una AZ? ¿Y de una región? | 11 |
| ☐ | ALB vs NLB: ¿cuál para gRPC y por qué? | 02, 11 |
| ☐ | ¿Cómo controlás costos? ¿Cuál es el mayor gasto oculto típico? | 11 |

### Sistemas de IA / agentes

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | Diseñá un sistema de agentes con herramientas. ¿Qué es sync y qué async? | 02, 14 |
| ☐ | ¿Cómo manejás una llamada de 40 s en una arquitectura HTTP? | 01, 14 |
| ☐ | ¿Cómo hacés idempotente el bucle de un agente que llama herramientas con efectos? | 06, 14 |
| ☐ | Diseñá RAG para 10 millones de documentos. ¿Dónde están los cuellos de botella? | 14 |
| ☐ | El costo de inferencia es el 70% del gasto. ¿Qué palancas de arquitectura tenés? | 01, 14 |
| ☐ | ¿Cómo evaluás que un cambio de prompt no rompió nada en producción? | 14 |
| ☐ | ¿Cómo hacés streaming de tokens si el worker no es el pod que tiene la conexión? | 02, 14 |

---

## 3. Preguntas de profundidad (deep dive)

Aparecen en la fase 5, después de que dibujaste. Son las que separan
"conoce las cajas" de "operó el sistema".

| ✅ | Pregunta | Módulo |
| --- | --- | --- |
| ☐ | Explicá CAP. ¿Por qué "elegir CA" es una respuesta incorrecta? | 05 |
| ☐ | ¿Qué es PACELC y por qué es más útil que CAP en la práctica? | 05 |
| ☐ | Niveles de aislamiento de una transacción. ¿Cuál usa Postgres por defecto? ¿Qué anomalía deja pasar? | 05 |
| ☐ | ¿Qué es un índice y por qué agregar uno puede hacer más lenta tu app? | 05 |
| ☐ | ¿Cómo funciona la replicación? ¿Qué es el replication lag y qué bug produce? | 05 |
| ☐ | ¿Qué es consistent hashing y qué problema resuelve exactamente? | 03 |
| ☐ | ¿Qué es un circuit breaker? ¿Cuáles son sus tres estados? | 08 |
| ☐ | ¿Por qué backoff con **jitter** y no backoff a secas? | 08 |
| ☐ | ¿Qué es backpressure? ¿Qué hace tu sistema cuando lo recibe? | 01, 08 |
| ☐ | ¿Qué es un fallo metaestable? ¿Por qué el sistema no vuelve solo? | 01, 08 |
| ☐ | ¿Qué es el patrón outbox y qué problema exacto resuelve? | 09 |
| ☐ | ¿Qué es una saga? ¿Coreografía u orquestación? ¿Cuándo cada una? | 09 |
| ☐ | ¿Qué es CQRS? ¿Cuándo NO usarlo? | 09 |
| ☐ | ¿Qué es el bloom filter y dónde lo usarías? | 04, 05 |
| ☐ | ¿Cómo generás IDs únicos en un sistema distribuido? Comparar UUIDv4, ULID, Snowflake | 03, 05 |

---

## 4. Preguntas de experiencia (comportamentales técnicas)

No tienen respuesta correcta. Tienen respuesta **preparada**: un caso real,
con el número, la decisión y lo que aprendiste. Escribí las tuyas antes de
necesitarlas — improvisar esto sale mal.

| ✅ | Pregunta |
| --- | --- |
| ☐ | Contame del peor incidente de producción que te tocó. ¿Cuál fue la causa raíz? |
| ☐ | Contame de una decisión de arquitectura de la que te arrepentiste |
| ☐ | ¿Cómo convenciste a un equipo de NO hacer algo técnicamente interesante? |
| ☐ | Contame de un sistema que rediseñaste. ¿Qué medías antes y qué después? |
| ☐ | ¿Cómo manejás la deuda técnica cuando Producto empuja features? |
| ☐ | ¿Cómo decidís entre arreglar bien y arreglar rápido? |
| ☐ | Contame de algo que hayas aprendido de un error de otro |

**Formato para prepararlas** (una variante de STAR con foco técnico):

1. **Contexto** — el sistema y el número (escala, latencia, usuarios).
2. **El problema** — qué se rompía y cómo te enteraste.
3. **Las opciones** — las dos o tres que evaluaste, **con sus trade-offs**.
4. **La decisión** — qué elegiste y por qué, con el criterio explícito.
5. **El resultado** — el número después. Si salió mal, **decilo**: es la
   respuesta más valiosa de todas, siempre que cierres con qué aprendiste.

Tené tres casos escritos y ensayados. Con tres bien contados se cubre
prácticamente cualquier pregunta de esta sección.

---

## 5. Cómo llevar la cuenta

Sugerencia: creá `mis-respuestas/entrevistas.md` y anotá cada simulacro:

```markdown
## 2026-09-15 — Diseñá un rate limiter (45 min)

**Cómo me fue:** 6/10
**Qué salió bien:** pregunté por el alcance (¿por usuario? ¿por IP? ¿por
endpoint?) antes de diseñar; estimé el QPS.
**Qué salió mal:** me olvidé del race condition en el read-modify-write del
contador; el entrevistador tuvo que preguntármelo dos veces.
**A repasar:** módulo 06 (operaciones atómicas), Lua scripts en Redis.
```

Ese registro es la parte que hace que esto sea entrenamiento y no lectura.

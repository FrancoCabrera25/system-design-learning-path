# System Design Learning Path

Ruta de aprendizaje de **arquitectura y diseño de sistemas**, paso a paso:
teoría corta + ejemplo ejecutable + cuestionario tipo entrevista en cada
módulo, de menor a mayor complejidad.

No es un repo de "leer y asentir". Cada módulo tiene código que se corre,
se rompe y se mide — y un cuestionario que respondés vos, con las
respuestas modelo aparte para corregirte.

El stack de los ejemplos es el mismo con el que trabajás: **TypeScript /
NestJS, gRPC, Kafka, Redis, Postgres, AWS**, más un tramo final sobre
**arquitectura de sistemas de IA / agentes**.

## Cómo está organizado

Cada módulo vive en `modules/NN-nombre/` y tiene:

| Archivo | Qué es |
| --- | --- |
| `README.md` | Teoría mínima necesaria, con foco en lo que se pregunta en entrevistas y lo que duele en producción. |
| `*.ts` | Código ejecutable. Sin dependencias donde se puede; `docker-compose` donde hace falta infra real. |
| `quiz.md` | Preguntas tipo entrevista. **Se responden antes de mirar las respuestas.** |
| `respuestas.md` | Respuestas modelo + rúbrica (qué separa una respuesta de junior, de senior y de staff) + fuentes. |

Tus respuestas van en `mis-respuestas/NN.md` para poder compararlas más
adelante y ver cómo evolucionó tu criterio.

## Requisitos

- **Node.js >= 22.18** — los ejemplos son `.ts` y se corren directo con
  `node archivo.ts` (Node ya hace type-stripping nativo, no hace falta
  compilar ni instalar `ts-node`).
- **Docker** — sólo a partir del módulo 04, para levantar Redis, Kafka y
  Postgres reales.

```bash
node --version   # debe decir v22.18.0 o mayor
node modules/01-fundamentos/percentiles.ts
```

Si tenés Node 20 o 22 viejo, instalá `tsx` una vez y usá `npx tsx archivo.ts`.

## Roadmap

### Fase 1 — Fundamentos (los primeros principios)

| # | Módulo | Tema | Estado |
| - | ------ | ---- | ------ |
| 01 | [Fundamentos](modules/01-fundamentos/) | Latencia, throughput, percentiles, Ley de Little, back-of-the-envelope, SLI/SLO | ✅ |
| 02 | [Comunicación entre servicios](modules/02-comunicacion-servicios/) | Síncrono vs asíncrono, REST vs gRPC vs eventos, contratos y versionado | ✅ |
| 03 | Escalabilidad | Vertical vs horizontal, load balancing, stateless, consistent hashing | ⏳ |
| 04 | Caching | Redis, cache-aside vs write-through, invalidación, stampede, TTL con jitter | ⏳ |
| 05 | Bases de datos | Índices, transacciones, aislamiento, réplicas, sharding, CAP/PACELC | ⏳ |
| 06 | Consistencia y coordinación | Consistencia eventual, **idempotencia**, locks distribuidos, leader election | ⏳ |

### Fase 2 — Sistemas distribuidos aplicados

| # | Módulo | Tema | Estado |
| - | ------ | ---- | ------ |
| 07 | Mensajería y event-driven | **Kafka** a fondo: particiones, orden, consumer groups, offsets, exactly-once | ⏳ |
| 08 | Fiabilidad | Timeouts, retries con backoff+jitter, circuit breaker, bulkhead, DLQ | ⏳ |
| 09 | Patrones de datos distribuidos | Outbox/Inbox, Saga, CQRS, event sourcing | ⏳ |
| 10 | Observabilidad | Logs/métricas/traces, OpenTelemetry, RED/USE, alertas que sirven | ⏳ |

### Fase 3 — Arquitectura, cloud y IA

| # | Módulo | Tema | Estado |
| - | ------ | ---- | ------ |
| 11 | AWS building blocks | ALB/NLB, ECS/EKS/Lambda, RDS/Aurora/DynamoDB, SQS/SNS/EventBridge/MSK, multi-AZ | ⏳ |
| 12 | Seguridad y multi-tenancy | AuthN/AuthZ, mTLS, secretos, rate limiting, aislamiento por tenant | ⏳ |
| 13 | Diseño y evolución de APIs | Versionado, paginación, **idempotency keys**, compatibilidad hacia atrás | ⏳ |
| 14 | Arquitectura de sistemas de IA | RAG, colas de inferencia, streaming, costos/tokens, idempotencia en tool-calls, evals | ⏳ |
| 15 | Capstone | Diseñar un sistema end-to-end + simulacro de entrevista completo | ⏳ |

### Transversal

- [`interview/`](interview/) — el **método** para responder una entrevista de
  system design (no el contenido: el proceso) y el banco de preguntas.

## Cómo usarlo

1. Leé el `README.md` del módulo.
2. Corré el código. Cambiale los números. Rompelo a propósito.
3. Respondé el `quiz.md` **sin mirar** `respuestas.md`, escribiendo en
   `mis-respuestas/NN.md`.
4. Recién ahí abrí `respuestas.md` y compará contra la rúbrica.
5. Lo que fallaste, volvé a la sección de teoría correspondiente.

## Reglas del juego

1. **Ningún diseño sin números.** "Escalable" no es una respuesta. QPS,
   GB/día, p99 en ms y costo estimado sí lo son. El módulo 01 existe para
   eso y se usa en todos los demás.
2. **Todo trade-off tiene un costo explícito.** Cada vez que elijas una
   opción, tenés que poder nombrar qué perdés. Una respuesta sin "a cambio
   de" está incompleta.
3. **Nada de arquitectura de PowerPoint.** Si el módulo tiene código, se
   corre. Ver el p99 explotar en tu propia terminal enseña más que leerlo.

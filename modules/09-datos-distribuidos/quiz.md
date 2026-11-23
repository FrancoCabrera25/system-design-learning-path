# Cuestionario — Módulo 09

> Respondé en `mis-respuestas/09.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Qué problema resuelve cada uno de estos cuatro patrones:
outbox, saga, CQRS, event sourcing?"* Una frase por patrón, 90 segundos en
total. Si no podés nombrar el problema sin nombrar la solución, no lo tenés.

**A2.** Una saga es **ACD**, no ACID. ¿Qué letra falta y qué significa en la
práctica? Nombrá las **tres** anomalías que aparecen por eso.

**A3.** ⏱️ Diferencia entre **coreografía** y **orquestación** en una saga.
Dame un criterio concreto para elegir, no "depende".

**A4.** ¿Por qué una compensación **no** es un rollback? Dame un ejemplo del
mundo real donde la diferencia se ve a ojo.

**A5.** Nombrá **cuatro** de las contramedidas de aislamiento de Richardson y
decí qué sacrifica cada una.

**A6.** ¿Qué es **exactamente** CQRS? ¿En qué nivel de los 5 del README
estás si tenés `OrdersQueryService` y `OrdersCommandService` leyendo de la
misma tabla? ¿Y si la lectura va a una réplica?

**A7.** ⏱️ *"¿Cuándo NO usarías event sourcing?"* 2 minutos. Es la pregunta
que separa a quien lo leyó de quien lo mantuvo.

**A8.** En un event store, ¿para qué sirve `PRIMARY KEY (stream_id, version)`
más allá de la unicidad? ¿Qué patrón de un módulo anterior es exactamente?

**A9.** ¿Por qué un snapshot puede volverse **incorrecto** sin que nadie
toque la base de datos? ¿Cómo se defiende de eso el código que lee snapshots?

**A10.** Un compañero propone: *"arranquemos el servicio nuevo con outbox,
saga, CQRS y event sourcing desde el día 1, así no migramos después"*.
Respondé en 4 frases y proponé el orden que sí.

---

## Bloque B — Números

**B1.** El `event-sourcing.ts` dice que a 50 ms de presupuesto entran ~1.640
eventos por stream.
- (a) ¿De dónde sale ese número? Reconstruí la cuenta.
- (b) Un agregado tiene 400.000 eventos y querés cargarlo en menos de 20 ms.
      ¿Cada cuántos eventos tomás snapshot? Justificá con el **peor** caso,
      no con el promedio.
- (c) ¿Qué pasa con el costo de carga si el stream sigue creciendo a
      1.000 eventos/día durante 3 años más? ¿Y si NO hay snapshots?

**B2.** CQRS nivel 4, proyección en Elasticsearch, 300 escrituras/s.
- (a) El p50 del lag es 200 ms y el front refetchea la lista inmediatamente
      después del POST. ¿Qué porcentaje de usuarios no ve su escritura?
- (b) ¿Y si el front espera 1 segundo?
- (c) ¿Por qué el p99 de una proyección es un orden de magnitud peor que el
      p99 de una réplica de lectura? Nombrá los saltos.

**B3.** Event store con 16.000.000 de eventos nuevos por año y 2 cambios de
esquema por año.
- (a) ¿Cuántos saltos de upcast se aplican en una reconstrucción completa en
      el año 5? Hacé la cuenta.
- (b) ¿Por qué el tiempo de reconstrucción crece **cuadrático** y no lineal?
- (c) En el año 5, reconstruir tarda 1 hora. ¿Qué hacés para que esa hora no
      sea una hora de downtime del modelo de lectura?

**B4.** Una saga de 4 pasos con 99,9% de éxito por paso, 1.000 sagas/día.
- (a) ¿Cuántas sagas por día entran en compensación?
- (b) Si la compensación del paso 2 falla, ¿qué pasa? ¿Cuál es el estado del
      sistema y quién lo arregla?
- (c) ¿Por qué el último paso de una saga nunca debería necesitar
      compensación? ¿Cómo se ordenan los pasos para conseguirlo?

---

## Bloque C — Diseño

**C1.** Diseñá el **alta de un pedido** en tu stack (NestJS + gRPC + Postgres
+ Kafka) con 3 servicios: `orders`, `payments`, `inventory`.
- (a) ¿Coreografía u orquestación? Justificá con el criterio de A3.
- (b) Escribí los pasos y la compensación de cada uno.
- (c) ¿Dónde entra el outbox? ¿Cuántos outbox hay?
- (d) ¿Dónde entra la idempotencia y con qué clave?
- (e) ¿Qué pasa si `inventory` ya reservó y `payments` falla **y** la
      compensación de `inventory` también falla? Dibujá la salida.

**C2.** Tu equipo tiene un endpoint `GET /pedidos` con 9 JOINs que tarda
2,8 s en p99 y es el 70% de la carga de la base.
- (a) Recorré los niveles 0 a 4 de CQRS y decí qué ganás y qué pagás en cada
      salto.
- (b) ¿En qué nivel te quedás y por qué?
- (c) Si eligieras el nivel 4, ¿qué cambia en el front y qué endpoint
      necesita read-your-writes?

**C3.** Te piden "event sourcing" para un módulo de **límites de crédito**:
cada cliente tiene un límite que cambia por decisiones manuales de riesgo,
por scoring automático y por reclamos, y el equipo de compliance pregunta
seguido *"¿por qué este cliente tenía este límite el 14 de marzo?"*.
- (a) ¿Es un buen candidato? Justificá con la regla de la sección C del
      `event-sourcing.ts`.
- (b) Diseñá los eventos (nombres y campos) y el agregado.
- (c) ¿Qué pasa en 2 años cuando el equipo de riesgo quiera partir
      `LimiteAjustado` en `LimiteSubido` y `LimiteBajado`? Escribí el plan.
- (d) ¿Qué parte del sistema **no** hacés con event sourcing?

**C4.** ⏱️ *"Tenemos una saga de 6 pasos escrita a mano con eventos de Kafka.
Nadie sabe en qué paso está una saga sin leer 6 topics, y cuando una se
cuelga a la mitad no hay forma de reanudarla."* 5 minutos: diagnóstico y
plan de migración, sin reescribir todo de cero.

---

## Bloque D — Tu stack

**D1.** `@nestjs/cqrs` te da `CommandBus`, `QueryBus` y `EventBus`.
¿En qué nivel de CQRS te pone? ¿Qué hace el `EventBus` cuando el proceso se
cae entre el `commit()` y el handler? ¿Qué patrón falta?

**D2.** Tenés la saga orquestada en un servicio NestJS con el estado en una
tabla `saga_state`. El pod muere entre el paso 3 y el 4.
- (a) ¿Quién reanuda la saga y cómo se enteró?
- (b) ¿Qué pasa si **dos** pods la reanudan al mismo tiempo?
- (c) ¿Qué te daría Temporal o Step Functions que esta tabla no te da?
      ¿Y qué perdés al adoptarlos?

**D3.** Tu agente de IA ejecuta 7 herramientas en secuencia, dos de ellas
cobran dinero y una tarda 40 segundos. El usuario cierra el navegador en el
paso 4.
- (a) ¿Es una saga? ¿Cuáles son las compensaciones?
- (b) ¿Qué guardás y con qué granularidad para poder reanudar?
- (c) ¿Qué pasa si el LLM devuelve una decisión **distinta** al reanudar?
      (Esta es la pregunta difícil.)

**D4.** Querés la proyección de `GET /pedidos` en DynamoDB, alimentada desde
Postgres por Kafka con Debezium.
- (a) Dibujá el camino completo y marcá cada punto donde se puede perder o
      duplicar un evento.
- (b) ¿Por qué la proyección tiene que ser idempotente y cómo la hacés?
- (c) ¿Qué pasa el día que el slot de replicación de Debezium se queda atrás
      y Postgres no puede hacer `VACUUM`? (Está en `outbox-brokers.md`.)

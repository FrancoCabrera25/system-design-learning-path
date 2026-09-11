# Cuestionario — Módulo 03

> Respondé en `mis-respuestas/03.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Escalarías vertical u horizontal?"* Respondé en 90 segundos,
con el criterio y con el motivo por el que **no** es una elección obvia.

**A2.** ¿Qué significa que un servicio sea *stateless*? Nombrá **cinco**
lugares donde el estado se esconde en una app NestJS típica, y adónde va
cada uno.

**A3.** Diferencia entre *liveness* y *readiness probe*. Describí el
incidente concreto que ocurre si el *liveness* chequea la base de datos.

**A4.** ¿Qué son *connection draining* y *slow start* en un balanceador?
¿Qué se rompe si no configurás cada uno?

**A5.** ⏱️ Explicá **consistent hashing** en 2 minutos: el problema que
resuelve, cómo funciona, y por qué hacen falta nodos virtuales.

**A6.** ¿Por qué *sticky sessions* es una solución que "funciona" y aun así
la tratamos como deuda técnica? Nombrá tres costos concretos.

---

## Bloque B — Números y algoritmos

**B1.** Tenés 20 pods. 3 están degradados (responden 5x más lento) pero
pasan el health check. Usás round robin.
- (a) ¿Qué porcentaje del tráfico va a los degradados?
- (b) Si la flota está al 70% de utilización global, ¿cuál es la utilización
      de un pod degradado? ¿Qué pasa con su cola?
- (c) ¿Cómo cambia con *power of two choices*? ¿Por qué alcanza con mirar
      **dos** servidores y no hace falta mirar los 20?

**B2.** Caché distribuido de 8 nodos con `hash(key) % 8`, 40.000 req/s y 96%
de hit rate. Se **cae** un nodo.
- (a) ¿Qué porcentaje de claves cambia de nodo?
- (b) ¿Cuántas req/s le llegan a la base inmediatamente después?
- (c) ¿Cuántas veces el tráfico normal es eso?
- (d) Con consistent hashing, ¿cuánto sería? ¿Es suficiente para estar
      tranquilo?

**B3.** Migrás de 4 shards a 6 con `hash(tenant_id) % N`.
- (a) ¿Qué fracción de los datos hay que mover?
- (b) Describí cómo hacés esa migración **sin downtime**. ¿Qué pasa con las
      escrituras que llegan durante la copia?
- (c) ¿Qué habrías hecho distinto el día 1 para no estar en esta situación?

**B4.** Tu tabla `events` tiene 800 millones de filas y PK `UUID v4`. El
`INSERT` pasó de 2 ms a 45 ms en los últimos seis meses, sin cambios en el
código ni en el tráfico.
- (a) ¿Qué está pasando? Explicá el mecanismo.
- (b) ¿Por qué empeoró *gradualmente* y no de golpe?
- (c) ¿Cómo lo confirmás antes de tocar nada?
- (d) ¿Qué hacés? (Ojo: cambiar la PK de una tabla de 800M filas no es una
      migración cualquiera.)

**B5.** Tu HPA escala por CPU con objetivo 70%. El servicio pasa el 90% del
tiempo esperando respuestas de un LLM.
- (a) ¿Qué va a pasar en un pico de tráfico?
- (b) ¿Qué métrica usarías en su lugar y por qué?
- (c) Un pico dura 90 segundos. ¿El autoescalado sirve? Justificá con el
      tiempo de reacción.

---

## Bloque C — Aplicado a tu stack

**C1.** Tu servicio NestJS tiene esto y pasás de 1 a 4 pods:

```ts
@Cron('0 3 1 * *')   // 3 AM del día 1 de cada mes
async facturarTodos() { ... }
```

- (a) ¿Qué pasa el 1 del mes que viene?
- (b) Resolvelo con un lock de Redis. Escribí el código y decí **qué falla**
      en tu propia solución.
- (c) Resolvelo **sin** lock. ¿Por qué es mejor?

**C2.** Guardás las sesiones de WebSocket en un `Map` del servicio. Escalás
a 5 pods.
- (a) ¿Qué se rompe exactamente cuando el pod 3 quiere emitirle un evento a
      un usuario conectado al pod 1?
- (b) Dos soluciones distintas, con sus costos.

**C3.** Tu consumer de Kafka procesa 500 msg/s y el lag crece. Escalás el
deployment de 3 a 12 réplicas. El lag **no baja en absoluto**. ¿Por qué?
¿Cuál es la primera pregunta que hacés?

**C4.** Estás diseñando el esquema de una tabla nueva que va a recibir
50.000 inserts/día y crecer indefinidamente. ¿Qué tipo de ID elegís?
Justificá contra las otras tres opciones, y decí en qué caso concreto
cambiarías de opinión.

---

## Bloque D — Diseño abierto ⏱️

**D1.** Diseñá un **rate limiter distribuido** para una API con 50 pods,
100.000 req/s, límite de 1.000 req/min por API key.
- ¿Dónde vive el contador?
- ¿Qué pasa si dos pods incrementan el mismo contador al mismo tiempo?
- ¿Qué algoritmo: token bucket, ventana fija, ventana deslizante? Trade-offs.
- ¿Qué hacés si se cae Redis: dejás pasar todo o bloqueás todo?
- ¿Cuánta latencia le agrega a cada request? ¿Se puede evitar?

**D2.** Un servicio tiene 200.000 usuarios y crece 20% por mes. Hoy corre
en una instancia de Postgres de 16 vCPU / 64 GB al 45% de CPU. El CTO
pregunta: *"¿cuándo hay que shardear?"*. Respondé como un senior: qué
medís, qué hacés **antes** de shardear, y cuál es la señal concreta que te
haría decir "ahora sí".

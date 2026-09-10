# Cuestionario — Módulo 01

> **Reglas:** respondé en `mis-respuestas/01.md` **sin abrir `respuestas.md`**.
> Sin buscar en Google. Si no sabés, escribí "no sé" — es información útil,
> mucho más que una respuesta a medias copiada.
> Las que dicen ⏱️ son preguntas de entrevista reales: respondelas **en voz
> alta y cronometradas**, porque en la entrevista no vas a poder editar.

---

## Bloque A — Conceptos

**A1.** Tu dashboard muestra "latencia promedio: 45 ms" y el equipo está
contento. ¿Por qué ese número no te dice nada sobre la salud del servicio?
¿Qué tres números pedirías en su lugar y por qué esos tres?

**A2.** ⏱️ Explicá qué es la **amplificación de cola** (*tail latency
amplification*) en menos de 90 segundos, con un ejemplo numérico.

**A3.** La CPU de tus pods está en 85% y el equipo dice "estamos aprovechando
bien la infraestructura". Argumentá por qué eso es peligroso. Usá números.

**A4.** ¿Cuál es la diferencia entre SLI, SLO y SLA? ¿Por qué el SLO tiene
que ser **más estricto** que el SLA y no al revés?

**A5.** Definí **error budget**. Tu SLO es 99,95% mensual y en los primeros
9 días del mes ya tuviste 14 minutos de caída. ¿Qué decisión concreta
tomarías como responsable técnico, y con qué argumento se la explicás a
Producto cuando te pidan lanzar una feature grande la semana que viene?

---

## Bloque B — Números

**B1.** Una app tiene 5 millones de usuarios activos diarios. Cada uno hace
20 acciones por día. Calculá:
- (a) QPS promedio
- (b) QPS pico, justificando el factor que elegís
- (c) Si cada acción escribe 500 bytes y se guardan 2 años, ¿cuánto storage?
- (d) ¿A partir de qué número de esos empezarías a pensar en sharding?

**B2.** Tu servicio recibe 800 req/s y cada request tarda 250 ms en promedio.
- (a) ¿Cuántas requests hay dentro del sistema en un momento dado?
- (b) Si cada pod maneja 40 requests concurrentes, ¿cuántos pods necesitás?
- (c) Si la latencia sube a 400 ms y el tráfico no cambia, ¿qué pasa con
      la cantidad de pods necesaria? ¿Por qué esto convierte a una
      degradación de latencia en un incidente de capacidad?

**B3.** Un endpoint hace 4 llamadas gRPC **en paralelo**, cada servicio con
p99 = 200 ms y p50 = 20 ms.
- (a) ¿Cuál es el p50 aproximado del endpoint?
- (b) ¿Y el p99? ¿Es 200 ms, más, o menos? Justificá.
- (c) ¿Qué cambia si las 4 llamadas fueran **secuenciales**?

**B4.** Tu servicio A depende sincrónicamente de B, C y D, cada uno con
99,9% de disponibilidad.
- (a) ¿Cuál es el techo de disponibilidad de A?
- (b) ¿Cuántos minutos de downtime mensual son?
- (c) Nombrá **dos** cambios de diseño distintos que suban ese techo sin
      tocar la disponibilidad de B, C ni D.

**B5.** Un usuario en Buenos Aires le pega a tu API en `us-east-1`. El
backend responde en 15 ms. El usuario percibe 400 ms. ¿Dónde se fueron los
385 ms restantes? Enumerá los sospechosos en orden de probabilidad.

---

## Bloque C — Aplicado a tu stack

**C1.** Un endpoint NestJS que sólo hace un `SELECT` indexado empieza a
tener p99 de 3 segundos mientras el p50 sigue en 12 ms y la base está
tranquila. Dame las **cuatro** causas más probables, en orden, y cómo
confirmás cada una.

**C2.** Tenés 15 pods, cada uno con un pool de 30 conexiones a Postgres, que
soporta 400 conexiones. ¿Cuál es el problema? ¿Qué pasa exactamente en un
autoscaling que lleva los pods a 25? ¿Cuál es la solución?

**C3.** Un consumer de Kafka procesa 1.200 mensajes/s y cada mensaje tarda
80 ms. El lag empieza a crecer. Con la Ley de Little: ¿cuál es la
concurrencia mínima necesaria? Si el topic tiene 6 particiones, ¿podés
llegar a ese número sólo agregando instancias del consumer? (Pensalo bien:
esta es la pregunta trampa del módulo 07.)

**C4.** Diseñás un endpoint que llama a un LLM. La llamada tarda entre 3 y
40 segundos. Enumerá **todo** lo que se rompe si lo exponés como un
`POST /chat` síncrono que espera la respuesta completa, y qué diseño
proponés en su lugar.

---

## Bloque D — Diseño abierto ⏱️

**D1.** Te dan 10 minutos: *"Diseñá el sistema de notificaciones de una app
con 2 millones de DAU."* **No diseñes todavía.** Escribí sólo:
- las 5 preguntas de aclaración que harías primero, y
- los números que estimarías antes de dibujar una sola caja.

Después, con tus propias estimaciones, decidí: ¿la notificación se manda
síncrona o asíncrona? ¿Por qué, con qué número lo justificás?

**D2.** Un compañero propone: *"metamos Kafka, así escala"*. El sistema
tiene 40 req/s y un solo servicio. Sin ser condescendiente, ¿qué le
respondés? ¿Qué número le pedís antes de aceptar o rechazar?

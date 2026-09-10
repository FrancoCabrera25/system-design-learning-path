# El método para una entrevista de system design

Este directorio no enseña arquitectura: enseña **cómo se conduce la
conversación**. Es la parte que se puede practicar por separado, y la que
más candidatos seniors pierden por no haberla practicado nunca.

El entrevistador no está evaluando si sabés qué es Kafka. Está evaluando:

1. **¿Hacés las preguntas correctas antes de diseñar?** (el filtro más duro)
2. **¿Justificás con números o con opiniones?**
3. **¿Nombrás los trade-offs de tus propias decisiones?**
4. **¿Podés bajar a profundidad cuando te empujan a un componente?**
5. **¿Se puede trabajar con vos?** (¿escuchás las señales, o te aferrás?)

Una respuesta técnicamente perfecta sin trade-offs nombrados puntúa peor
que una respuesta razonable que dice "elegí esto **a costa de** aquello".

---

## El reparto del tiempo (45 minutos)

| Fase | Tiempo | Qué hacés |
| --- | --- | --- |
| **1. Requisitos** | 5-8 min | Preguntar. **No dibujar nada todavía.** |
| **2. Estimaciones** | 3-5 min | Números en la pizarra. QPS, storage, ancho de banda. |
| **3. API y modelo de datos** | 5 min | Los endpoints/eventos principales y las entidades. |
| **4. Diseño de alto nivel** | 10-12 min | Las cajas y las flechas. El camino feliz. |
| **5. Deep dive** | 10-15 min | **El entrevistador elige** el componente. Acá se gana o se pierde. |
| **6. Cuellos de botella** | 5 min | Qué se rompe primero, qué monitoreás, qué harías con 10x. |

El error #1, y el más caro: **empezar a dibujar cajas en el minuto 2**. Si
hacés eso, ya perdiste la fase 1 completa, que es donde se evalúa el criterio.

---

## Fase 1 — Requisitos (la fase que define la nota)

El enunciado siempre es deliberadamente ambiguo. "Diseñá Twitter" no es un
requisito: es una invitación a preguntar.

### Requisitos funcionales — qué hace

- ¿Cuáles son **las 2 o 3 features centrales**? (nunca las 20)
- ¿Quién lo usa y para qué?
- ¿Qué queda **explícitamente fuera de alcance**? Decirlo en voz alta y
  acordarlo protege el resto de la entrevista.

### Requisitos no funcionales — cómo tiene que comportarse

**Estos son los que eligen la arquitectura.** Los cinco imprescindibles:

1. **Escala** — ¿cuántos usuarios? ¿DAU o registrados? ¿crecimiento?
2. **Lectura vs escritura** — ¿100:1? ¿1:1? Define caché, réplicas, y si el
   sistema es de lectura o de escritura.
3. **Latencia** — ¿cuál es el p99 aceptable? ¿Para qué operación?
4. **Consistencia** — **la pregunta más importante y la que menos se hace.**
   ¿Es aceptable que un usuario vea datos de hace 2 segundos? Si sí, se abren
   caché, réplicas de lectura y eventos. Si no (saldos, stock, reservas), casi
   todo eso queda descartado.
5. **Disponibilidad** — ¿cuántos nueves? ¿Qué pasa si se cae 5 minutos?
   ¿Multi-región?

### Las preguntas que hacen la diferencia

Nadie las hace y todas cambian el diseño:

- *"¿Cuál es el peor caso aceptable de **inconsistencia**?"*
- *"¿Cuál es el **factor pico** sobre el promedio?"* (el módulo 01 completo)
- *"¿Hay **restricciones de compliance** — GDPR, residencia de datos, auditoría?"*
  Meten borrado real, cifrado y multi-región en el diseño desde el minuto 1.
- *"¿Qué es más caro para el negocio: **perder un dato** o **mostrar un dato
  viejo**?"* Esta sola pregunta ordena la mitad de las decisiones que vienen.

Cerrá la fase resumiendo en voz alta: *"Entonces diseño para X usuarios, ratio
Y:1 de lectura, p99 de Z ms, consistencia eventual aceptable salvo en W.
¿Estamos de acuerdo?"*. Ese resumen es un checkpoint que evita rediseñar en
el minuto 35.

---

## Fase 2 — Estimaciones

Ritual del módulo 01, en voz alta y redondeando:

```
DAU × acciones/día = acciones/día
acciones/día ÷ 86.400 (≈ 100.000) = QPS promedio
QPS promedio × factor pico = QPS pico     <-- dimensionás por ESTE
QPS × tamaño del payload = ancho de banda
escrituras/día × bytes × retención = storage
```

Tres reglas:

1. **Redondeá agresivamente.** 86.400 ≈ 100.000. Nadie quiere ver aritmética.
2. **Declará cada supuesto.** *"Asumo un factor pico de 5 porque es tráfico
   humano regional; si hay eventos masivos, esto cambia a 10 y el diseño de
   ingest tiene que absorber ráfagas."* **Un supuesto declarado nunca está
   mal; un número sin supuesto siempre puede estarlo.**
3. **Terminá diciendo qué decide el número.** El cálculo no vale por sí
   mismo: *"5.000 escrituras/s pico significa que una instancia de Postgres
   no alcanza para el patrón de escritura, así que..."*.

---

## Fase 5 — Deep dive: donde se gana o se pierde

El entrevistador te va a llevar a **un** componente. Ahí quiere ver
profundidad real: números, casos borde, modos de falla.

Preparate para bajar a fondo en estos, que son los que más se piden:

- **La base de datos**: elección del motor, esquema, índices, particionado,
  qué pasa cuando no entra en una instancia.
- **La caché**: qué se cachea, TTL, invalidación, **stampede**, qué pasa si
  Redis se cae (¿la base aguanta el 100% del tráfico de golpe? Casi nunca).
- **La cola / el broker**: particiones, orden, duplicados, DLQ, consumer lag,
  qué pasa cuando el consumer estuvo caído 3 horas.
- **El camino de escritura**: idempotencia, transacciones, outbox, sagas.

Frase que siempre suma, en cualquier deep dive:

> *"Antes de entrar en detalle: ¿cuál de estos dos te interesa más, el camino
> de escritura o el de lectura?"*

Muestra que sabés que hay dos problemas distintos y te evita gastar 10
minutos en el que no le importa.

---

## Fase 6 — Cuellos de botella

Cerrá vos, no esperes a que te lo pidan:

1. **¿Qué se rompe primero si el tráfico se multiplica por 10?** Nombrá el
   componente concreto y el síntoma.
2. **¿Cuál es el punto único de falla?** ¿Qué pasa si esa AZ desaparece?
3. **¿Qué métricas alertarías?** No "CPU y memoria": **consumer lag, p99 por
   endpoint, tasa de error, saturación del pool de conexiones, error budget
   consumido.**
4. **¿Qué NO hice y por qué?** *"No metí multi-región porque el requisito de
   disponibilidad era 99,9% y multi-región activo-activo agrega complejidad
   de consistencia que no se justifica. Si el requisito subiera a 99,99%, lo
   revisaría."* Esto vale muchísimo: muestra que sabés cuándo **no** aplicar
   algo que sabés hacer.

---

## Frases que suman (y por qué)

| Frase | Qué demuestra |
| --- | --- |
| *"Antes de diseñar, necesito entender tres cosas..."* | Que no diseñás a ciegas |
| *"Asumo X; si fuera Y, esto cambiaría en Z"* | Supuestos explícitos y flexibilidad |
| *"Elijo A a costa de B, porque el requisito prioriza C"* | Trade-off razonado |
| *"Esto se rompe cuando..."* | Que pensaste los límites de tu propio diseño |
| *"Empezaría simple con X y migraría a Y cuando el número llegue a Z"* | Que no sobre-diseñás |
| *"No sé, pero lo averiguaría así..."* | Honestidad + método (vale más que inventar) |

## Frases que restan

| Frase | Por qué |
| --- | --- |
| *"Usaría microservicios porque escalan mejor"* | Cargo cult, sin número |
| *"Le metemos Kafka"* (a 40 req/s) | Solución sin problema |
| *"Esto es web scale"* | No significa nada |
| *"Usaría MongoDB porque es NoSQL"* | La categoría no es una razón |
| Silencio largo mientras pensás | **Pensá en voz alta.** El proceso *es* la evaluación |
| Aferrarte a tu diseño cuando el entrevistador insiste | La insistencia **siempre** es una pista |

---

## Errores fatales

1. **Diseñar antes de preguntar.** El más común y el más caro.
2. **No usar números.** "Escalable" no es una respuesta.
3. **Sobre-diseñar.** Multi-región activo-activo para 1.000 usuarios muestra
   falta de criterio, no conocimiento.
4. **Ignorar las señales.** Si el entrevistador pregunta dos veces por lo
   mismo, no está curioso: te está mostrando un agujero.
5. **No nombrar los trade-offs.** Toda decisión tiene un costo; si no lo
   decís, la conclusión es que no lo conocés.
6. **Quedarte en las cajas.** "Un servicio de usuarios, uno de órdenes, una
   base" no es un diseño: es un diagrama. La sustancia está en el deep dive.

---

## Cómo practicar con este repo

1. Elegí una pregunta de [`banco-preguntas.md`](banco-preguntas.md).
2. Poné un timer de 45 minutos y **hablá en voz alta**, grabándote.
3. Dibujá en papel o en Excalidraw. Nada de tipear.
4. Escuchá la grabación. Chequeá contra esta lista:
   - ¿Pregunté al menos 5 cosas antes de dibujar?
   - ¿Dije al menos 5 números?
   - ¿Nombré el costo de cada decisión importante?
   - ¿Dije "esto se rompe cuando..."?
   - ¿Hubo silencios de más de 10 segundos?
5. Traeme la grabación o el resumen y lo corregimos como un entrevistador.

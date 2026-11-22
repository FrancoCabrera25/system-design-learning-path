# Casos reales

Los `modules/` enseñan **por qué** las cosas se rompen, con simulaciones que
te muestran el número. Esta carpeta es lo otro: **el problema concreto, la
solución que ya está probada en producción, el código, y por qué se hace así
y no de las otras tres formas que parecen razonables.**

Son los casos que aparecen una y otra vez en sistemas de microservicios con
eventos. Ninguno es inventado: todos tienen nombre propio, están
documentados por equipos que los sufrieron, y la solución es la que la
industria convergió a usar.

## El formato

Cada caso tiene la misma estructura, siempre en este orden:

| Sección | Qué contesta |
| --- | --- |
| **1. El escenario** | El sistema concreto, con números. Sin números no hay caso |
| **2. Qué se rompe** | El síntoma que ves, y la causa real (que casi nunca es la misma cosa) |
| **3. La solución probada** | El patrón, con su nombre, y quién lo usa en producción |
| **4. La implementación** | Código completo, no pseudocódigo. NestJS / TypeScript / SQL |
| **5. Por qué así y no de otra forma** | Las alternativas que parecen razonables, y por qué se descartan |
| **6. Cómo sabés que funciona** | Las métricas, las alertas, y cómo lo testeás |
| **7. El costo** | Qué estás pagando por esta solución. Siempre hay uno |

La sección 5 es la razón de ser de esta carpeta. Implementar un patrón es
fácil; **saber por qué las otras opciones no funcionan es lo que te permite
defenderlo en una entrevista y no abandonarlo en el primer problema.**

## Los casos

| # | Caso | El problema en una línea | Módulos | |
| - | ---- | ------------------------ | ------- | - |
| 01 | [El evento que nunca salió](01-outbox-el-evento-que-nunca-salio.md) | La orden existe, el envío nunca se reserva, y no hay ningún error en ningún log | 02, 06 | ✅ |
| 02 | [El cobro duplicado que no figura en ningún log](02-idempotencia-cobro-duplicado.md) | Un `UNIQUE` impecable y aun así le cobraste dos veces | 06, 05 | ✅ |
| 03 | [El pago que salió bien y el envío que falló](03-saga-pago-cobrado-sin-envio.md) | Ya cobraste. No hay rollback. ¿Y ahora? | 09, 02 | ✅ |
| 04 | El tenant que rompió el pipeline | Un cliente nuevo y el lag de una partición crece para siempre | 07, 03 | ⏳ |
| 05 | El checkout que se cayó por las recomendaciones | Un servicio no crítico tumbó el crítico sin que se tocaran | 08, 01 | ⏳ |
| 06 | El 500 que no se va | El pico pasó hace media hora y el sistema sigue roto | 08, 01 | ⏳ |
| 07 | "A veces no se guarda" | El `POST` devuelve 200 y el `GET` devuelve el dato viejo | 05 | ⏳ |
| 08 | La ampliación del caché que tiró la base | Agregaste un nodo de Redis y se cayó Postgres | 04, 03 | ⏳ |
| 09 | De 4 a 6 shards sin downtime | El 67% de los datos tiene que cambiar de máquina | 05, 03 | ⏳ |
| 10 | El bucle del agente que se puede reanudar | El pod se recicla a los 30 s de una generación de 40 s | 06, 14 | ⏳ |

Los tres primeros son los patrones que más se preguntan y los que más se
implementan a medias. El resto va saliendo a medida que avanzan los módulos
correspondientes.

## Cómo usarlos

**Si estás resolviendo un problema ahora**, andá directo al caso. Las
secciones 1 y 2 te dicen si es tu problema; la 4 te da el código; la 5 te
evita el rediseño en tres meses.

**Si estás estudiando para entrevistas**, leé la sección 5 de cada uno. Las
preguntas de diseño casi nunca son *"¿conocés el patrón outbox?"*: son
*"¿por qué no lo resolvés simplemente publicando después del commit?"*. Esa
respuesta está en la 5.

**Si querés practicar**, leé la 1 y la 2, cerrá el archivo, y escribí tu
solución antes de ver la 3. Es el mismo método que los `quiz.md` de los
módulos.

---

> Los casos asumen la teoría de los módulos correspondientes. Si algo no se
> explica acá, está explicado allá — y el caso lo referencia con el número de
> sección exacto.

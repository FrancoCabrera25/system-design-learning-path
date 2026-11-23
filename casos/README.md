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

| # | Caso | El problema en una línea | Módulos |
| - | ---- | ------------------------ | ------- |
| 01 | [El evento que nunca salió](01-outbox-el-evento-que-nunca-salio.md) | La orden existe, el envío nunca se reserva, y no hay ningún error en ningún log | 02, 06 |
| 02 | [El cobro duplicado que no figura en ningún log](02-idempotencia-cobro-duplicado.md) | Un `UNIQUE` impecable y aun así le cobraste dos veces | 06, 05 |
| 03 | [El pago que salió bien y el envío que falló](03-saga-pago-cobrado-sin-envio.md) | Ya cobraste. No hay rollback. Y la saga no falla: se cuelga | 09, 02 |
| 04 | [El tenant que rompió el pipeline](04-kafka-particion-caliente.md) | Escalaste a 48 réplicas y 96 particiones, y el lag sigue creciendo | 07, 03 |
| 05 | [El checkout que se cayó por las recomendaciones](05-bulkhead-dependencia-no-critica.md) | Un servicio no crítico tumbó el crítico sin que se tocaran | 08, 01 |
| 06 | [El 500 que no se va](06-retry-storm-colapso-metaestable.md) | El pico pasó hace media hora y el sistema sigue roto | 08, 01 |
| 07 | ["A veces no se guarda"](07-replication-lag-a-veces-no-se-guarda.md) | El `POST` devuelve 200, el `GET` devuelve el dato viejo, y no es reproducible | 05 |
| 08 | [La ampliación del caché que tiró la base](08-cache-ampliacion-que-tiro-la-base.md) | Agregaste un nodo de Redis para aliviar la base y la base se murió | 04, 03 |
| 09 | [De 4 a 6 shards sin downtime](09-migracion-de-shards-sin-downtime.md) | El 67% de los datos tiene que cambiar de máquina, sin ventana | 05, 03 |
| 10 | [El bucle del agente que se puede reanudar](10-agente-ia-bucle-reanudable.md) | El pod se recicla a los 30 s de un bucle de 4 minutos, y pagás todo de nuevo | 06, 07, 14 |

### Por si estás buscando un patrón concreto

| Patrón | Caso |
| --- | --- |
| Transactional Outbox | [01](01-outbox-el-evento-que-nunca-salio.md) |
| Idempotency Key | [02](02-idempotencia-cobro-duplicado.md), [10](10-agente-ia-bucle-reanudable.md) |
| Saga con compensaciones | [03](03-saga-pago-cobrado-sin-envio.md) |
| Clave de partición | [04](04-kafka-particion-caliente.md) |
| Bulkhead · Circuit breaker | [05](05-bulkhead-dependencia-no-critica.md) |
| Retry budget · Load shedding | [06](06-retry-storm-colapso-metaestable.md) |
| Read-your-writes | [07](07-replication-lag-a-veces-no-se-guarda.md) |
| Consistent hashing · Single-flight | [08](08-cache-ampliacion-que-tiro-la-base.md) |
| Shards lógicos · expand/migrate/contract | [09](09-migracion-de-shards-sin-downtime.md) |
| Durable execution | [10](10-agente-ia-bucle-reanudable.md) |

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

# Módulo 09 — Patrones de datos distribuidos

> Outbox · Saga · CQRS · Event Sourcing

---

## Por qué acá

Hasta el módulo 05, "la base de datos" era una. Desde el 02, cada servicio
tiene **la suya**. Y de ahí sale el problema que define a este módulo:

> **No existe ninguna transacción que abarque tu sistema.** Ni `BEGIN`, ni
> `COMMIT`, ni `ROLLBACK`. Las garantías que te daba Postgres —atomicidad,
> aislamiento— terminan en el borde de cada servicio.

Los cuatro patrones de este módulo son **cuatro respuestas distintas a cuatro
problemas distintos** que nacen de ese hecho. Y el error más común no es
implementarlos mal: es **adoptarlos todos juntos porque suenan a "arquitectura
moderna"**, cuando cada uno resuelve algo que quizás no tenés.

## Material de este módulo

| Archivo | Qué es |
| --- | --- |
| Este `README.md` | La teoría de los cuatro patrones |
| [`quiz.md`](quiz.md) · [`respuestas.md`](respuestas.md) | Preguntas de entrevista y respuestas modelo |
| `saga-anomalias.ts` · `cqrs-lag.ts` · `event-sourcing.ts` | Los ejemplos ejecutables |
| [`casos/01`](../../casos/01-outbox-el-evento-que-nunca-salio.md) · [`casos/03`](../../casos/03-saga-pago-cobrado-sin-envio.md) | **La implementación completa** de outbox y saga, con código y alternativas descartadas |

Este módulo da la **teoría y los trade-offs**; los casos dan el **código**. Si
venís a implementar, andá directo a los casos.

## Teoría mínima

### 1. El mapa: qué resuelve cada uno

Esto es lo primero que hay que tener claro, porque los cuatro se mencionan
juntos y **no son capas del mismo patrón**:

| Patrón | La pregunta que responde | Alcance |
| --- | --- | --- |
| **Outbox** | *"¿Cómo garantizo que el evento salga si guardé el dato?"* | **Un** mensaje, una transacción |
| **Saga** | *"¿Qué hago si el paso 3 falla después de que el paso 2 ya cobró?"* | **Un flujo** de N pasos, minutos u horas |
| **CQRS** | *"¿Cómo sirvo lecturas complejas sin castigar al modelo de escritura?"* | **Un servicio**, su forma interna |
| **Event Sourcing** | *"¿Cómo sé cómo llegué a este estado?"* | **El almacenamiento** de un agregado |

Y las dependencias entre ellos, que importan:

```
          SAGA  (el QUÉ: pasos y compensaciones)
            │
            │  usa en cada paso
            ▼
         OUTBOX  (el CÓMO se entrega cada mensaje)

          CQRS  (separar lectura de escritura)
            │
            │  NO lo requiere, pero se combinan seguido
            ▼
     EVENT SOURCING  (el log como fuente de verdad)
```

- **La saga usa el outbox.** Sin él, la saga no falla: **se cuelga**
  ([caso 03](../../casos/03-saga-pago-cobrado-sin-envio.md)).
- **CQRS no requiere event sourcing**, y event sourcing **sí** empuja hacia
  CQRS (si guardás eventos, necesitás proyecciones para leer).
- **Los cuatro son independientes del broker.** Ninguno es "de Kafka".

### 2. Outbox — el resumen

Ya lo vimos a fondo en el [módulo 02](../02-comunicacion-servicios/) y en el
[caso 01](../../casos/01-outbox-el-evento-que-nunca-salio.md). El resumen de
una línea:

> **El evento no se publica: se escribe como una fila más, en la misma
> transacción que el dato.** Un proceso aparte lo publica.

```sql
BEGIN;
  INSERT INTO orders (...);
  INSERT INTO outbox (...);     -- el evento, como FILA
COMMIT;                          -- o quedan las dos, o no queda ninguna
```

Lo que importa recordar acá:

1. **Es at-least-once garantizado.** Si el publisher muere entre publicar y
   marcar, republica. Por eso **el outbox y el consumidor idempotente son el
   mismo patrón** (módulo 06).
2. **El índice parcial** (`WHERE published_at IS NULL`) es lo que hace que el
   polling no escale con el histórico.
3. **Sólo hace falta si cambiás tu estado Y además avisás.** Si sólo publicás,
   publicá directo ([`outbox-cuando.md`](../02-comunicacion-servicios/outbox-cuando.md)).

El hermano del outbox es el **inbox**: la tabla de deduplicación del lado del
consumidor. Mismo mecanismo, dirección opuesta.

### 3. Saga — y la letra que le falta

Una **saga** es un flujo de larga duración partido en transacciones locales,
donde cada paso tiene **una acción** y **una compensación**. Lo formalizó
Garcia-Molina en 1987.

La implementación está en el [caso 03](../../casos/03-saga-pago-cobrado-sin-envio.md).
Acá va lo que el caso no explica: **la propiedad que las sagas no tienen.**

#### Las sagas dan ACD, no ACID

| | ¿La saga lo da? |
| --- | --- |
| **A**tomicidad | ✅ Sí, *semánticamente*: o se completa o se compensa |
| **C**onsistencia | ✅ Sí, al terminar |
| **I**solation | ❌ **NO. Y es lo que nadie dice.** |
| **D**urabilidad | ✅ Sí, cada paso commitea local |

**Por qué no hay aislamiento:** cada paso **commitea de verdad** en su base.
Eso significa que **el estado intermedio de una saga es visible para todo el
mundo** mientras la saga está en curso. No hay nada que lo esconda.

Y de ahí salen tres anomalías que **no existen en una transacción de base de
datos**:

| Anomalía | Qué pasa |
| --- | --- |
| **Lost update** | La saga B sobrescribe un cambio de la saga A sin haberlo leído |
| **Dirty read** | La saga B lee un dato que la saga A va a compensar (o sea, que "nunca existió") |
| **Fuzzy read** | Dos pasos de la misma saga leen el mismo dato y obtienen valores distintos |

El *dirty read* es el más difícil de aceptar, porque **el dato era real**: la
saga A commiteó. Lo que pasa es que después compensó, y la saga B ya tomó una
decisión basada en algo que fue revertido.

#### Las contramedidas (Richardson)

No se "arreglan": se **mitigan**, eligiendo por caso.

| Contramedida | Cómo | Cuándo |
| --- | --- | --- |
| **Semantic lock** | Un flag que dice "en curso" (`PENDIENTE_PAGO`). Los demás lo ven y esperan, fallan o lo manejan | **La más usada.** Es el estado intermedio del caso 03 |
| **Commutative updates** | Operaciones cuyo orden no importa: `saldo = saldo - 50`, no `saldo = 100` | Siempre que se pueda. Gratis |
| **Pessimistic view** | Reordenar los pasos para que el estado riesgoso dure lo menos posible | Cuando un dirty read cuesta plata |
| **Reread value** | Antes de escribir, releer y verificar que no cambió (lock optimista) | Contra lost updates |
| **Version file** | Registrar las operaciones y reordenarlas si llegan fuera de orden | Cuando no podés controlar el orden |
| **By value** | Elegir el mecanismo **según el riesgo del request**: saga para lo barato, bloqueo real para lo caro | La más madura y la que menos se usa |

El **semantic lock** es el que ya usás sin saber que tiene nombre: el estado
`PENDIENTE_PAGO` de una orden **es** un semantic lock. Le está diciendo al
resto del sistema *"esta orden está en el medio de algo, no asumas nada"*.

Lo vas a medir en `saga-anomalias.ts`.

#### Coreografía vs orquestación

| | **Coreografía** | **Orquestación** |
| --- | --- | --- |
| Cómo | Cada servicio escucha eventos y reacciona | Un orquestador manda comandos y lleva el estado |
| Acoplamiento | Bajo: nadie conoce a los demás | El orquestador conoce a todos |
| ¿Dónde está el flujo? | **Repartido en N repos** | **En un solo lugar** |
| Bueno para | 3-5 pasos, flujo lineal | 8+ pasos, ramas condicionales |

**La regla: coreografía hasta que el flujo deje de caber en tu cabeza.** El
síntoma de que hay que migrar: nadie puede responder *"¿qué pasa si el paso 7
falla?"* sin abrir siete repositorios.

Y lo que **no** cambia con ninguna de las dos: **cada paso sigue necesitando
outbox e idempotencia**. El orquestador también cambia estado y emite
comandos — también necesita outbox.

### 4. CQRS — separar lectura de escritura

**Command Query Responsibility Segregation.** Viene de la separación
*command/query* de Bertrand Meyer, y lo nombró Greg Young.

> **Un modelo para escribir, otro para leer.** Porque la forma óptima para
> validar invariantes **no es** la forma óptima para responder consultas.

El problema que resuelve, concretamente:

```sql
-- El modelo normalizado es perfecto para ESCRIBIR (invariantes, sin duplicación)
-- y es un desastre para esta pantalla:
SELECT o.id, c.nombre, c.email, SUM(i.cantidad * i.precio) AS total,
       e.estado_actual, t.nombre AS transportista, COUNT(d.id) AS devoluciones
FROM ordenes o
  JOIN clientes c ON ...        -- 7 JOINs
  JOIN items i ON ...
  LEFT JOIN envios e ON ...
  LEFT JOIN transportistas t ON ...
  LEFT JOIN devoluciones d ON ...
WHERE o.tenant_id = $1
GROUP BY ...
ORDER BY o.created_at DESC LIMIT 50;
```

#### CQRS tiene niveles, y casi nadie necesita el último

| Nivel | Qué es | Costo | ¿Consistencia eventual? |
| --- | --- | --- | --- |
| **0** | Los mismos objetos para todo | — | No |
| **1** | **DTOs de lectura distintos de las entidades** | Casi cero | No |
| **2** | **Queries SQL a medida**, sin pasar por el ORM | Bajo | No |
| **3** | **Vistas materializadas** en la misma base | Medio | Sí, acotada |
| **4** | **Base de lectura separada** (Elasticsearch, una tabla desnormalizada) | **Alto** | **Sí, visible** |

> **El nivel 1 y el 2 son CQRS y no cuestan nada.** Dejar de usar la entidad
> de escritura como respuesta de la API, y escribir una query a medida para esa
> pantalla, ya es separar responsabilidades.

Casi todo el valor de CQRS está en los niveles 1-3. **El nivel 4 es el que
duele** y es el único que la gente llama "CQRS".

#### Cuándo el nivel 4 se justifica

- **Ratio de lectura/escritura muy desparejo** (100:1 o más) y las lecturas son
  complejas.
- **Necesitás un motor distinto para leer**: búsqueda full-text, agregaciones
  analíticas, geoespacial.
- **Varias formas muy distintas de ver lo mismo**: una API móvil, un dashboard,
  un export.
- **Las lecturas y las escrituras escalan a ritmos distintos** y querés
  escalarlas por separado.

#### Y el costo que no se negocia

> **Consistencia eventual VISIBLE para el usuario.** Escribe, y su propia
> escritura **no aparece** en la lista hasta que la proyección se actualice.

Es el mismo bug del [caso 07](../../casos/07-replication-lag-a-veces-no-se-guarda.md),
con otra causa: no es el lag de una réplica, es el lag de la **proyección**. Y
las soluciones son las mismas, lo vas a medir en `cqrs-lag.ts`.

### 5. Event Sourcing — guardar los hechos, no el estado

> **En vez de guardar el estado actual, guardás la secuencia de eventos que lo
> produjeron. El estado es un `fold` sobre los eventos.**

```
❌ ESTADO (lo normal)
   cuentas: { id: 'c1', saldo: 150 }
   ¿Cómo llegó a 150? NO SE SABE. La información no existe.

✅ EVENTOS
   CuentaAbierta       { id: 'c1', saldo: 0 }
   DineroDepositado    { monto: 200 }
   DineroRetirado      { monto: 80 }
   DineroDepositado    { monto: 30 }
   ─────────────────────────────────
   saldo = fold(eventos) = 150
```

**Lo que ganás, y es genuinamente valioso:**

1. **Auditoría perfecta por construcción.** No es un log paralelo que puede
   divergir: **es la fuente de verdad**.
2. **Viaje en el tiempo.** El estado en cualquier instante del pasado es un
   `fold` parcial. *"¿Cuál era el saldo el 3 de marzo a las 14:00?"* es una
   query, no una investigación.
3. **Proyecciones nuevas sobre datos viejos.** Alguien pide una vista que nadie
   había pensado: la construís reprocesando **todo el histórico**. Con estado,
   esa información se perdió el día que se sobrescribió.
4. **Debugging real.** Reproducís el bug con la secuencia exacta de eventos
   que lo causó.

**Las cuatro piezas de la implementación:**

```ts
// 1. El AGREGADO: la unidad de consistencia. Un stream de eventos por agregado.
class Cuenta {
  private version = 0;
  private saldo = 0;

  // 2. APLICAR: el fold. Debe ser PURO y DETERMINÍSTICO.
  private aplicar(e: Evento) {
    switch (e.tipo) {
      case 'DineroDepositado': this.saldo += e.monto; break;
      case 'DineroRetirado':   this.saldo -= e.monto; break;
    }
    this.version++;
  }

  // 3. DECIDIR: valida la invariante y PRODUCE eventos (no muta nada todavía)
  retirar(monto: number): Evento[] {
    if (monto > this.saldo) throw new SaldoInsuficienteError();
    return [{ tipo: 'DineroRetirado', monto }];
  }
}
```

```sql
-- 4. EL EVENT STORE: append-only, con control de concurrencia optimista
CREATE TABLE eventos (
  stream_id uuid        NOT NULL,
  version   int         NOT NULL,
  tipo      text        NOT NULL,
  payload   jsonb       NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, version)    -- ← el UNIQUE es el lock optimista
);
```

Ese `PRIMARY KEY (stream_id, version)` es todo el control de concurrencia: si
dos procesos intentan escribir la versión 42 del mismo stream, **uno falla** y
reintenta releyendo. Es el lock optimista del
[módulo 05](../05-bases-de-datos/) convertido en el mecanismo central.

**Snapshots**, porque reconstruir 500.000 eventos en cada request no escala:

```sql
CREATE TABLE snapshots (
  stream_id uuid PRIMARY KEY,
  version   int    NOT NULL,
  estado    jsonb  NOT NULL
);
-- Cargar = último snapshot + los eventos posteriores
```

Lo vas a medir en `event-sourcing.ts`: el efecto de los snapshots en el costo
de carga es dramático y define si el patrón es viable.

#### El problema real de event sourcing: el versionado

Todo lo anterior es la parte fácil. Ésta es la que hunde proyectos:

> **Los eventos son inmutables y viven para siempre. Cuando el negocio cambia,
> tenés eventos de 2023 con una forma que tu código de 2026 ya no entiende — y
> no podés editarlos.**

```ts
// 2023: el evento original
{ tipo: 'OrdenCreada', v: 1, total: 15000 }                   // centavos, implícito

// 2024: ahora hay multi-moneda
{ tipo: 'OrdenCreada', v: 2, total: 15000, moneda: 'ARS' }

// 2026: el total se descompone
{ tipo: 'OrdenCreada', v: 3, subtotal: 12000, impuestos: 3000, moneda: 'ARS' }
```

Y tu código tiene que poder leer **las tres formas, para siempre**. Las
estrategias:

| Estrategia | Cómo | Costo |
| --- | --- | --- |
| **Upcasting** | Una función que convierte v1→v2→v3 al leer | Una cadena de upcasters que crece sin parar |
| **Weak schema** | Los eventos son JSON tolerante; campos opcionales | El código se llena de `??` y defaults |
| **Copy & replace** | Un stream nuevo con los eventos migrados | Rompe el "inmutable", y hay que hacerlo bien |

**Es el costo que nadie estima al adoptar event sourcing**, y es permanente:
crece con cada año de histórico.

#### Cuándo event sourcing sí, y cuándo no

**Sí** — y la lista es más corta de lo que parece:

- **La auditoría es un requisito del dominio**, no un nice-to-have:
  contabilidad, salud, trading, legal. *"Tengo que poder demostrar cómo se
  llegó a este número."*
- **El "cómo llegó" tiene valor de negocio**: el carrito abandonado, el
  recorrido del usuario, el historial clínico.
- **Necesitás muchas vistas distintas** del mismo hecho, y aparecen nuevas
  seguido.
- **El dominio ya piensa en eventos**: un libro mayor, una historia clínica, un
  tracking de envíos. En esos casos, el estado es la **derivada** y los eventos
  son lo natural.

**No** — y éste es el caso normal:

- **Un CRUD.** Si el dominio es "crear, editar, borrar", event sourcing es
  complejidad pura sin beneficio.
- **El equipo no lo conoció antes.** La curva es empinada y los errores son
  caros y permanentes (los eventos mal diseñados no se borran).
- **Necesitás consultas ad-hoc sobre el estado.** Sin proyecciones armadas de
  antemano, *"dame todas las cuentas con saldo negativo"* es imposible: hay que
  reconstruir **todos** los agregados.
- **Borrado real por GDPR.** Un log inmutable y el derecho al olvido chocan de
  frente. Se resuelve con **crypto-shredding** (cifrar los datos personales con
  una clave por usuario y borrar la clave), pero hay que diseñarlo desde el día
  uno.

> **La pregunta honesta: ¿el histórico de cómo llegaste al estado tiene valor
> de negocio, o sólo te parece elegante?** Si es lo segundo, una tabla de
> auditoría te da el 80% del valor por el 5% del costo.

### 6. CQRS + Event Sourcing: por qué van juntos y por qué eso duplica el costo

Si guardás eventos, **no podés consultar el estado**: `SELECT * FROM cuentas
WHERE saldo < 0` no existe, porque no hay tabla `cuentas`. Así que event
sourcing **te obliga** a construir proyecciones para leer — o sea, CQRS
nivel 4.

```
COMANDO -> agregado -> EVENTOS (fuente de verdad)
                          │
                          ├──► proyección "saldos"        (Postgres)
                          ├──► proyección "movimientos"   (Postgres)
                          └──► proyección "búsqueda"      (Elasticsearch)
                                     ▲
                               CONSULTAS leen de acá
```

Y ahí aparecen, **juntos**, todos los costos:

- Consistencia eventual visible (`cqrs-lag.ts`).
- Las proyecciones hay que **poder reconstruirlas**, y reconstruir una sobre
  10 años de eventos tarda horas ([caso: módulo 07, D1](../07-kafka/respuestas.md)).
- El versionado de eventos afecta a **todas** las proyecciones.
- Dos modelos, dos conjuntos de tests, dos cosas que pueden desincronizarse.

**Por eso el consejo de la mayoría de los que lo implementaron en serio es el
mismo:** usá event sourcing **en un agregado**, el que de verdad lo necesita
(el libro mayor, el historial clínico), y dejá el resto del sistema como un
CRUD normal. **No es una decisión de arquitectura global: es por agregado.**

### 7. El anti-patrón: los cuatro juntos "porque es lo moderno"

Es el fracaso más caro de este módulo, y tiene una forma reconocible:

```
Un CRUD de 3 entidades, con:
  - Event sourcing en todos los agregados
  - CQRS nivel 4 con Elasticsearch
  - Sagas para flujos de 2 pasos
  - Un orquestador para esas sagas
```

Lo que se obtiene: consistencia eventual en todo, imposibilidad de hacer una
query ad-hoc, versionado de eventos desde el primer mes, 4x el código, y un
equipo nuevo que tarda tres meses en poder tocar algo.

Lo que se resolvió: nada que un `JOIN` no resolviera.

**El orden correcto de adopción, de barato a caro:**

```
1. Outbox              ← casi siempre lo necesitás. Barato y acotado.
2. Consumidor idempotente  ← viene con el 1. No es opcional.
3. CQRS nivel 1-2      ← gratis. DTOs y queries a medida.
4. Saga                ← cuando hay un flujo multi-servicio con compensación.
5. CQRS nivel 3-4      ← cuando una pantalla concreta lo exige, con números.
6. Event Sourcing      ← cuando el histórico ES el requisito, en UN agregado.
```

Cada escalón se justifica con un problema que ya tenés, no con uno que podrías
tener.

### 8. Aplicado a tu stack

- **Outbox en NestJS/TypeORM**: la tabla y el publisher están en el
  [caso 01](../../casos/01-outbox-el-evento-que-nunca-salio.md).
- **CQRS nivel 1-2** es lo primero que conviene hacer: dejar de devolver
  entidades de TypeORM en la API, y escribir `queryBuilder` a medida para las
  pantallas pesadas. Cero infraestructura.
- **`@nestjs/cqrs`** te da `CommandBus`, `QueryBus` y `EventBus` **en memoria,
  dentro del proceso**. Es útil para ordenar el código y **no** te da nada de
  lo de este módulo: no es un event store, no es durable, y los eventos se
  pierden si el pod muere. No lo confundas con event sourcing.
- **Vistas materializadas de Postgres** (`REFRESH MATERIALIZED VIEW
  CONCURRENTLY`) son CQRS nivel 3 con cero infraestructura nueva. Es el escalón
  más subestimado.
- **Event store**: Postgres con la tabla de la sección 5 alcanza y sobra para
  la mayoría de los casos. EventStoreDB sólo si el volumen o las suscripciones
  lo justifican.
- **Agentes de IA** (módulo 14): la tabla `agent_steps` del
  [caso 10](../../casos/10-agente-ia-bucle-reanudable.md) **es** un event store
  de un agregado. La ejecución durable y el event sourcing son el mismo patrón
  con nombres distintos.

## Lo que vas a correr

```bash
node modules/09-datos-distribuidos/saga-anomalias.ts
node modules/09-datos-distribuidos/cqrs-lag.ts
node modules/09-datos-distribuidos/event-sourcing.ts
```

1. **`saga-anomalias.ts`** — la "I" que le falta a las sagas: dos sagas
   concurrentes sobre el mismo recurso producen lost updates y dirty reads que
   **no existen en una transacción**. Con y sin semantic lock.
2. **`cqrs-lag.ts`** — el costo de la consistencia eventual del nivel 4:
   cuántos usuarios no ven su propia escritura, y qué resuelve cada mitigación.
3. **`event-sourcing.ts`** — el costo de reconstruir un agregado según la
   cantidad de eventos, el efecto de los snapshots, y lo que cuesta una cadena
   de upcasters que crece año a año.

## Para pensar / próximo paso

- Dos sagas intentan reservar la última unidad de stock al mismo tiempo. Ambas
  ven stock disponible. ¿Qué pasa? ¿Qué contramedida usás y qué perdés?
- Tenés CQRS nivel 4 con la proyección en Elasticsearch. El usuario crea un
  producto y **no lo ve en el listado**. ¿Cuántas soluciones se te ocurren?
  ¿Cuál es la que no cuesta nada?
- Un agregado tiene 800.000 eventos. Cargarlo tarda 4 segundos. ¿Cada cuántos
  eventos tomás un snapshot? ¿Qué pasa cuando cambiás la lógica de `aplicar()`
  y los snapshots viejos quedan calculados con la lógica anterior?

## Fuentes

- **Chris Richardson**, `microservices.io` — los patrones de datos, con las
  contramedidas de aislamiento de sagas:
  <https://microservices.io/patterns/data/saga.html>
- **Garcia-Molina & Salem**, *Sagas* (SIGMOD 1987):
  <https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf>
- **Greg Young**, *CQRS Documents* y *Versioning in an Event Sourced System* —
  el libro sobre el problema de la sección 5:
  <https://leanpub.com/esversioning>
- **Martin Fowler**, *CQRS* y *Event Sourcing* — con las advertencias:
  <https://martinfowler.com/bliki/CQRS.html> ·
  <https://martinfowler.com/eaaDev/EventSourcing.html>
- **Kleppmann**, *DDIA* cap. 11 y 12 — *Event sourcing* y *Deriving current
  state from the event log*.
- **Oskar Dudycz**, `event-driven.io` — el blog más práctico sobre event
  sourcing con Postgres: <https://event-driven.io/>

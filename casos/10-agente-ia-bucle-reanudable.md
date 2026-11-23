# Caso 10 — El bucle del agente que se puede reanudar

> **Módulos:** [06 (idempotencia)](../modules/06-idempotencia/) ·
> [07 (Kafka)](../modules/07-kafka/) · 14 (sistemas de IA, *adelantado*)
> **Patrón:** Ejecución durable (*durable execution*)

---

## 1. El escenario

Plataforma de agentes de IA. El usuario manda un mensaje; un worker corre un
bucle ReAct: llama al LLM, el LLM decide llamar herramientas, con esos
resultados vuelve a llamar al LLM, y así hasta producir la respuesta final.

```
40.000 mensajes/día
el LLM tarda 3-40 s por llamada · USD 0,02 cada una
2 a 6 llamadas al LLM por mensaje
0 a 8 llamadas a herramientas por mensaje
```

Y las herramientas **tienen efectos reales**:

| Herramienta | Efecto |
| --- | --- |
| `buscarPedido(id)` | Ninguno: es una lectura |
| `enviarEmail(to, body)` | **Le llega un mail a una persona** |
| `crearTicket(desc)` | **Aparece un ticket en el sistema de soporte** |
| `emitirReembolso(ordenId, monto)` | **Se mueve plata** |

El worker consume de Kafka, con la configuración por defecto.

```
12 deploys / rebalances / pods reciclados por día
auto.commit.interval.ms = 5000 (el default)
```

## 2. Qué se rompe

**El síntoma, primera parte — la factura.** El costo de inferencia es un 35%
más alto de lo que predice el cálculo de tokens por mensaje. Nadie entiende de
dónde sale, y la hipótesis que circula es "los prompts deben ser más largos de
lo que pensamos".

**El síntoma, segunda parte — el que llega por soporte.** Clientes que
reciben **el mismo mail dos veces**. Tickets duplicados en el sistema de
soporte. Y una vez, **un reembolso emitido dos veces**.

**La causa.** El worker es un consumer de Kafka, y Kafka es **at-least-once**.
Cada deploy, cada rebalance, cada pod reciclado reprocesa los mensajes que no
llegaron a commitear su offset:

```
2.500 mensajes por evento (5 s de commit interval × 500 msg/s)
× 12 eventos/día = 30.000 reprocesos/día
```

Y acá está el problema específico de un agente: **reprocesar un mensaje no es
reprocesar una operación, es reprocesar un bucle entero**.

```
Mensaje: "cancelá mi pedido 8841 y avisame por mail"

INTENTO 1
  paso 0: LLM        -> decide llamar buscarPedido(8841)      $0,02   10 s
  paso 1: herramienta -> buscarPedido(8841)                            1 s
  paso 2: LLM        -> decide llamar cancelarPedido(8841)     $0,02   12 s
  paso 3: herramienta -> cancelarPedido(8841)   ← EFECTO REAL          2 s
  paso 4: LLM        -> decide llamar enviarEmail(...)         $0,02   11 s
  paso 5: herramienta -> enviarEmail(...)       ← EFECTO REAL          1 s
  💥 el pod se recicla acá (deploy), antes de commitear el offset

INTENTO 2 (otro pod toma la partición desde el mismo offset)
  paso 0: LLM        -> buscarPedido(8841)                     $0,02  ← PAGÁS DE NUEVO
  paso 1: herramienta -> buscarPedido(8841)
  paso 2: LLM        -> cancelarPedido(8841)                   $0,02  ← PAGÁS DE NUEVO
  paso 3: herramienta -> cancelarPedido(8841)   ← SEGUNDA CANCELACIÓN
  paso 4: LLM        -> enviarEmail(...)                       $0,02  ← PAGÁS DE NUEVO
  paso 5: herramienta -> enviarEmail(...)       ← SEGUNDO MAIL AL CLIENTE
  paso 6: LLM        -> respuesta final                        $0,02
```

**El bucle arranca de cero.** No perdiste un paso: perdiste seis, y los seis
cuestan dinero y producen efectos.

El costo, con los números de
[`entrega.ts`](../modules/06-idempotencia/entrega.ts):

```
30.000 reprocesos/día × ~3 llamadas al LLM × USD 0,02 × 365 = USD 657.000/año
```

Y el daño que no se mide en dólares: **mails duplicados, tickets duplicados y
un reembolso emitido dos veces.**

**El agravante de este dominio**, que no existe en un CRUD: una request HTTP
que se reintenta dura 200 ms, así que la ventana de duplicación es chica. **Un
bucle de agente dura entre 30 segundos y 4 minutos.** La probabilidad de que
un deploy lo atrape a mitad no es despreciable: es **alta**.

Con un deploy cada 2 horas y bucles de 90 segundos promedio, aproximadamente
**1 de cada 80 mensajes** queda partido.

## 3. La solución probada

**Ejecución durable** (*durable execution*): persistir el resultado de **cada
paso** apenas termina, y al reprocesar **leer los pasos completos en vez de
re-ejecutarlos**.

```
INTENTO 2, con ejecución durable
  paso 0: ya existe -> se LEE el resultado de la tabla        $0      0 ms
  paso 1: ya existe -> se LEE                                 $0      0 ms
  paso 2: ya existe -> se LEE                                 $0      0 ms
  paso 3: ya existe -> se LEE (NO se vuelve a cancelar)       $0      0 ms
  paso 4: ya existe -> se LEE                                 $0      0 ms
  paso 5: ya existe -> se LEE (NO se manda otro mail)         $0      0 ms
  paso 6: NUEVO -> LLM produce la respuesta final             $0,02  11 s
```

**El bucle se vuelve reanudable.** El pod se puede reciclar en cualquier
momento y el trabajo continúa donde estaba, sin repetir ningún efecto y sin
volver a pagar ningún token.

Es exactamente lo que hacen **Temporal**, **AWS Step Functions**,
**Restate** e **Inngest**. La diferencia es que acá lo construís a mano, lo
cual está bien hasta cierto tamaño — y la sección 5 dice cuándo deja de
estarlo.

## 4. La implementación

### 4.1 La tabla de pasos

```sql
CREATE TABLE agent_steps (
  message_id   uuid    NOT NULL,
  step_index   int     NOT NULL,          -- ← el número de paso del bucle
  tipo         text    NOT NULL,          -- 'LLM' | 'TOOL'
  nombre       text    NOT NULL,          -- el modelo, o el nombre de la herramienta
  args_hash    text    NOT NULL,          -- para detectar no-determinismo (§4.5)
  resultado    jsonb   NOT NULL,
  costo_usd    numeric(10,6),
  duracion_ms  int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, step_index)    -- ← LA GARANTÍA
);
```

Esa `PRIMARY KEY` **no es una regla lógica: es una estructura física**. El
segundo `INSERT` del mismo paso no "consulta y decide": choca contra el índice
y el motor lo bloquea **por debajo del nivel de aislamiento**
([módulo 05, C2](../modules/05-bases-de-datos/respuestas.md)).

### 4.2 El bucle reanudable

```ts
@Injectable()
export class AgentRunner {
  async ejecutar(messageId: string, mensajeUsuario: string): Promise<string> {
    // 1. Cargar lo ya hecho. En el primer intento esto viene vacío.
    const pasos = await this.repo.find({
      where: { messageId }, order: { stepIndex: 'ASC' },
    });

    const historial = this.reconstruirHistorial(mensajeUsuario, pasos);
    let stepIndex = pasos.length;         // ← arrancamos donde quedamos

    if (stepIndex > 0) {
      this.metricas.increment('agente.bucle_reanudado', { desde: stepIndex });
      this.logger.log(`Reanudando ${messageId} desde el paso ${stepIndex}`);
    }

    while (stepIndex < MAX_PASOS) {
      // 2. Cada paso pasa por el guard: si ya existe, se LEE
      const decision = await this.paso(messageId, stepIndex++, 'LLM', this.modelo,
        historial, () => this.llm.completar(historial));

      historial.push({ rol: 'assistant', contenido: decision });

      if (!decision.toolCall) return decision.texto;     // terminó

      const resultado = await this.paso(messageId, stepIndex++, 'TOOL',
        decision.toolCall.nombre, decision.toolCall.args,
        () => this.tools.ejecutar(decision.toolCall, { messageId, stepIndex }));

      historial.push({ rol: 'tool', contenido: resultado });
    }
    throw new MaxPasosExcedidoError(messageId);
  }
}
```

### 4.3 El guard de cada paso — el corazón del patrón

```ts
  private async paso<T>(
    messageId: string,
    stepIndex: number,
    tipo: 'LLM' | 'TOOL',
    nombre: string,
    args: unknown,
    ejecutar: () => Promise<T>,
  ): Promise<T> {
    const argsHash = sha256(canonicalizar(args));

    // ¿Ya se hizo este paso? Entonces NO se ejecuta: se lee.
    const previo = await this.repo.findOneBy({ messageId, stepIndex });
    if (previo) {
      // Chequeo de determinismo: si el agente pidió algo DISTINTO en este
      // paso, el replay no es válido (§4.5)
      if (previo.argsHash !== argsHash) {
        this.metricas.increment('agente.replay_no_determinista', { tipo, nombre });
        throw new ReplayNoDeterministaError(messageId, stepIndex);
      }
      this.metricas.increment('agente.paso_reusado', { tipo });
      return previo.resultado as T;
    }

    const t0 = Date.now();
    const resultado = await ejecutar();

    // Se persiste INMEDIATAMENTE, en su propia transacción corta.
    // Si el proceso muere en el próximo milisegundo, este paso ya está a salvo.
    await this.repo.createQueryBuilder().insert().into(AgentStep)
      .values({ messageId, stepIndex, tipo, nombre, argsHash,
                resultado, costoUsd: this.costoDe(resultado), duracionMs: Date.now() - t0 })
      .orIgnore()                 // ON CONFLICT DO NOTHING: otro pod nos ganó
      .execute();

    return resultado;
  }
```

**`orIgnore()` y no un `save()`:** si dos pods procesan el mismo mensaje en
paralelo (puede pasar durante un rebalance), los dos ejecutan el paso y **uno
de los dos `INSERT` falla**. Eso no es un error: es la carrera resuelta
correctamente. Y por eso los efectos necesitan **también** su propia clave de
idempotencia (§4.4): el `INSERT` perdedor no deshace el mail que ya se mandó.

### 4.4 Las herramientas con efectos: clave derivada del paso

```ts
@Injectable()
export class ToolExecutor {
  async ejecutar(call: ToolCall, ctx: { messageId: string; stepIndex: number }) {
    // La clave es DETERMINÍSTICA y derivada del PASO, no un uuid() nuevo
    const idemKey = `${ctx.messageId}:${ctx.stepIndex}:${call.nombre}`;

    switch (call.nombre) {
      case 'buscarPedido':
        return this.pedidos.buscar(call.args.id);        // lectura: sin clave

      case 'enviarEmail':
        return this.mailer.enviar({ ...call.args, idempotencyKey: idemKey });

      case 'emitirReembolso':
        return this.pagos.reembolsar({ ...call.args, idempotencyKey: idemKey });
    }
  }
}
```

**Doble protección, y las dos hacen falta:**

| Capa | Qué cubre |
| --- | --- |
| La tabla `agent_steps` | El reproceso normal: el paso ya está, no se ejecuta |
| La `idemKey` hacia el proveedor | La carrera entre dos pods, y la muerte entre ejecutar y persistir |

La segunda es la del [caso 02](02-idempotencia-cobro-duplicado.md): si el pod
muere **después** de mandar el mail y **antes** del `INSERT`, la tabla no sabe
nada y el reintento lo manda de nuevo. Sólo la clave del proveedor lo frena.

### 4.5 El detalle que más se equivoca: `stepIndex` en la clave

Ésta es la parte sutil, y es un error de diseño en las dos direcciones.

```ts
// ❌ MAL: deduplicar por herramienta + argumentos
const clave = sha256(messageId + call.nombre + JSON.stringify(call.args));
```

Parece más robusto —"si es la misma herramienta con los mismos argumentos, es
lo mismo"— y **rompe un caso completamente normal**:

```
El agente, razonando:
  paso 3: buscarPedido(8841)     -> estado: "PENDIENTE"
  paso 4: cancelarPedido(8841)
  paso 5: buscarPedido(8841)     -> quiere CONFIRMAR que quedó "CANCELADO"
                                     ↑ MISMA herramienta, MISMOS argumentos
```

Con la clave sin `stepIndex`, el paso 5 devuelve el resultado **cacheado** del
paso 3 — o sea `"PENDIENTE"` — y el agente concluye que la cancelación falló.
**Deduplicaste una acción que el agente pidió deliberadamente.**

Consultar el estado de algo **antes y después** de modificarlo es un patrón
básico de cualquier agente. Con `stepIndex` en la clave, el paso 3 y el paso 5
son pasos distintos y los dos se ejecutan.

> **Deduplicar de más es tan bug como deduplicar de menos.** Y es peor, porque
> produce respuestas incorrectas en silencio en vez de efectos duplicados
> visibles.

Y el `args_hash` del guard (§4.3) protege del caso inverso: si el replay llega
al paso 4 y el agente ahora pide **otra cosa**, el replay no es válido y hay
que fallar ruidosamente en vez de mezclar dos razonamientos.

### 4.6 Por qué el LLM no se puede "replayear", sólo leer

Hay una diferencia entre este diseño y la ejecución durable clásica que vale
entender, porque define cómo se persiste:

> **La ejecución durable clásica asume que el código es determinístico:
> re-ejecutás y obtenés lo mismo. Una llamada a un LLM NO es determinística.**

Dos ejecuciones con el mismo prompt pueden dar decisiones distintas —incluso
con `temperature: 0`, por el batching del proveedor y el no-determinismo de
punto flotante en GPU—. Así que la llamada al LLM **no es código a re-ejecutar:
es un efecto externo cuyo resultado hay que persistir**, igual que el mail.

En Temporal eso se llama *activity* (se persiste) y se distingue del *workflow
code* (se re-ejecuta). Si tratás la llamada al LLM como código replayable, al
reanudar el agente puede tomar **un camino distinto** del que ya ejecutó — y
entonces tenés los efectos del camino A con el razonamiento del camino B.

**Por eso se persiste la decisión del LLM, no sólo el resultado de las
herramientas.** Es la parte del diseño que no es obvia.

### 4.7 La configuración de Kafka — dos líneas que no son opcionales

```ts
const consumer = kafka.consumer({
  groupId: 'agent-runner',
  sessionTimeout: 45_000,
  maxPollInterval: 600_000,          // 10 min: el peor bucle tiene que entrar
  partitionAssigners: [PartitionAssigners.cooperativeSticky],
  groupInstanceId: process.env.POD_NAME,   // static membership
});

await consumer.run({
  eachMessage: async ({ message, heartbeat }) => {
    await this.runner.ejecutar(message.key.toString(), parse(message.value));
    await heartbeat();
  },
  autoCommit: false,                 // commit MANUAL, por mensaje
  partitionsConsumedConcurrently: 1,
});
```

**`max.poll.records = 1`** (o el equivalente del cliente) es obligatorio:
con bucles de hasta 4 minutos y el default de 500 registros, el batch tardaría
**33 horas** y caerías directo en el loop de rebalances
([módulo 07, C3](../modules/07-kafka/respuestas.md)). **Es el ajuste no obvio
más importante del diseño.**

Y el manejo de `SIGTERM`, que es lo que convierte un deploy en una operación
limpia:

```ts
process.on('SIGTERM', async () => {
  this.aceptandoTrabajo = false;        // no tomar mensajes nuevos
  await this.esperarBuclesEnCurso({ maxMs: 120_000 });   // terminar los que hay
  await this.consumer.disconnect();     // commitea lo terminado
  process.exit(0);
});
```

```yaml
# Y el grace period tiene que ser mayor que el peor bucle
terminationGracePeriodSeconds: 150
```

Con esto, un deploy normal **no parte ningún bucle**. La ejecución durable
queda como red de seguridad para lo que no es un deploy ordenado: un OOM kill,
una interrupción de spot, un nodo que se drena.

### 4.8 La cancelación — el costo que nadie mira

```ts
// Si el usuario cerró el navegador, terminar la generación CUESTA TOKENS
private async debeSeguir(messageId: string): Promise<boolean> {
  if (await this.redis.exists(`cancelado:${messageId}`)) return false;

  const ultimaConexion = await this.redis.get(`conectado:${messageId}`);
  if (!ultimaConexion) return true;                        // nunca hubo stream
  return Date.now() - Number(ultimaConexion) < 60_000;     // 60 s de gracia
}
```

Se chequea **entre pasos** del bucle, no en el medio de una llamada. Si el
usuario se fue hace más de un minuto, el bucle se detiene y el estado queda
persistido: si vuelve, se reanuda desde donde estaba.

## 5. Por qué así y no de otra forma

### ❌ "Deduplicamos por `messageId` y listo"

Es el arreglo que todo el mundo hace primero, y **resuelve el problema
equivocado**:

```ts
if (await this.repo.existsBy({ messageId })) return;   // ya procesado
```

Evita que el mensaje **se procese dos veces completo**. No evita nada del caso
real, que es que el bucle **se corte a mitad**: si el pod muere en el paso 5,
no hay ninguna fila de "procesado", así que el reintento **arranca de cero y
re-ejecuta los 5 pasos**.

> **La granularidad de la deduplicación tiene que coincidir con la granularidad
> del trabajo.** El trabajo acá no es el mensaje: es el paso.

### ❌ "Guardamos el estado del bucle en memoria / en Redis"

Un bucle que dura minutos **no puede vivir en la memoria de un pod** que se
recicla en cada deploy: es literalmente el escenario del caso.

Y Redis tampoco, por dos razones: es *at-most-once* en su durabilidad por
defecto (hasta 1 segundo de escrituras perdidas en una caída, y su replicación
asíncrona puede perder escrituras ya confirmadas en un failover), y **el
estado del bucle incluye efectos ya ejecutados** — "ya mandé el mail" es un
hecho de negocio, no un dato de caché
([caso 08](08-cache-ampliacion-que-tiro-la-base.md) para la discusión de
durabilidad de Redis).

Como caché de los pasos **arriba** de Postgres, perfecto. Como fuente de
verdad, no.

### ❌ "Hacemos el commit del offset antes de procesar" (at-most-once)

Elimina los duplicados y **pierde mensajes de usuarios**. Si el pod muere a
mitad del bucle, ese mensaje **no se procesa nunca** y el usuario se queda sin
respuesta, sin error y sin forma de saber qué pasó.

Para telemetría, at-most-once es razonable. **Para la pregunta de un usuario,
no.** Y los números no ayudan: 30.000 mensajes perdidos por día.

### ❌ "Subimos el timeout y que el bucle termine antes del deploy"

No se puede: el bucle dura lo que tarda el LLM, y eso no lo controlás. Un
mensaje complejo con 6 llamadas al modelo son 4 minutos, y **los deploys van a
seguir existiendo**.

Y si la idea es exponerlo como HTTP síncrono para "no depender de Kafka", el
límite es duro: **API Gateway corta a los 29 segundos**
([módulo 01, C4](../modules/01-fundamentos/respuestas.md)). No hay timeout que
configurar que lo arregle.

### ❌ "Activamos exactly-once de Kafka"

Es la confusión más cara del tema. Las transacciones de Kafka son **reales y
funcionan**: hacen atómico el ciclo *consumir → transformar → producir*, con el
offset y los mensajes de salida commiteados juntos. Cero duplicados **dentro
de Kafka**.

Y la llamada al LLM, el mail y el reembolso **ocurren fuera de Kafka**. Ninguna
transacción del broker los puede deshacer:

```
semántica                   duplicados en Kafka   LLAMADAS AL LLM DE MÁS   USD/año
at-least-once (sin dedup)              30.000                   30.000    $219.000  💀
Kafka EOS (transacciones)                   0                   30.000    $219.000  💀
"effectively once"                     30.000                        0    $      0  ✅
```

> **"Activamos exactly-once" no significa que tus efectos ocurran una vez.
> Significa que el mensaje no se duplica entre topics.** La garantía no vive
> en el broker: vive en el efecto
> ([módulo 06, A4](../modules/06-idempotencia/respuestas.md)).

### ❌ "Dedup por `hash(herramienta + argumentos)`"

El error de §4.5, y el más sutil del caso: **deduplica llamadas que el agente
pidió a propósito**. Consultar el estado antes y después de modificarlo es un
patrón normal, y con esta clave el agente lee un resultado viejo y concluye
cualquier cosa.

Produce **respuestas incorrectas en silencio**, que es peor que efectos
duplicados visibles.

### ❌ "Que las herramientas sean todas idempotentes y chau"

Es necesario y no suficiente, por dos razones:

1. **No elimina el costo del LLM.** Las herramientas no se duplican y las
   llamadas al modelo se vuelven a pagar enteras. Los USD 657.000 siguen ahí.
2. **No todas las herramientas pueden serlo.** `enviarEmail` con clave de
   idempotencia depende de que **el proveedor** la soporte, y muchos no la
   tienen. `crearTicket` en un sistema de terceros, igual.

La idempotencia de las herramientas es la **segunda** línea de defensa (§4.4).
La primera es no volver a ejecutarlas.

### ⚠️ "Usá Temporal / Step Functions en vez de construirlo"

**Es la alternativa más honesta de esta lista**, y conviene saber cuándo.

| | A mano (este caso) | Temporal / Step Functions |
| --- | --- | --- |
| Reanudar desde el paso N | ✅ | ✅ |
| Timers y esperas largas | A mano | ✅ Nativo |
| Versionado del código entre reanudaciones | ❌ **No resuelto** | ✅ |
| Visibilidad del flujo | Tus métricas | ✅ UI completa |
| Infraestructura | Una tabla | Un cluster más (o el servicio gestionado) |
| Curva de aprendizaje | Baja | **Alta** |

**El punto débil de la versión a mano es el versionado.** Si deployás un
cambio en el bucle mientras hay 400 bucles a mitad, esos bucles se reanudan
con **código nuevo** sobre **pasos viejos**. Si el paso 4 significaba otra cosa
en la versión anterior, el replay es inválido — y el `args_hash` del guard
detecta el síntoma pero no te da una solución.

**Mi criterio:** construilo a mano mientras el bucle sea lineal y los pasos
pocos. El día que necesites esperas de horas, señales externas, o
compensaciones encadenadas, **ya estás escribiendo un motor de workflows peor
que los que existen**.

Y decir esto en una entrevista —*"estoy construyendo a mano un motor de
ejecución durable; si esto crece, la pregunta es si conviene adoptar uno"*— es
exactamente la clase de observación que distingue a un senior de un staff.

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **`agente.bucle_reanudado`** | Cuántos bucles se retomaron | Si es **0**, el mecanismo no está conectado |
| **`agente.paso_reusado`** por tipo | Pasos que NO se volvieron a pagar | El ahorro, medido |
| **Costo USD por mensaje** (p50 y p99) | La métrica de negocio | Regresión semana a semana |
| **`agente.replay_no_determinista`** | Replays inválidos | **> 0 es un bug** (o un deploy a mitad) |
| **Duración del bucle** (p99) | Para calibrar `maxPollInterval` | **> 25% del intervalo** |
| **Tasa de rebalances del grupo** | La causa raíz del caso | Más de 1 cada 10 min |
| **Efectos duplicados detectados** por el proveedor | La segunda línea funcionando | Tendencia |

La primera es la más contraintuitiva: **si `bucle_reanudado` es cero, no
significa que nada se corte — significa que no estás midiendo**. Con 12
rebalances por día y bucles de 90 segundos, esperás decenas de reanudaciones
diarias.

Y la tercera es la que habría detectado el incidente original: **el costo por
mensaje**, no el costo total. El total subía con el tráfico y nadie lo
cuestionaba; el costo **por mensaje** mostraba un 35% inexplicable.

**Cómo lo testeás.** El test que importa es "matar el proceso a mitad", y se
puede escribir:

```ts
describe('bucle reanudable', () => {
  it('no re-ejecuta los pasos ya completados', async () => {
    const llm = espiarLLM();
    const mailer = espiarMailer();

    // Intento 1: muere después del paso 5
    await correrAgente('msg-1', 'cancelá el 8841 y avisame')
      .pero(matarEn({ paso: 6 }))
      .catch(() => {});

    expect(llm.llamadas).toBe(3);
    expect(mailer.enviados).toBe(1);

    // Intento 2: el reproceso
    await correrAgente('msg-1', 'cancelá el 8841 y avisame');

    expect(llm.llamadas).toBe(4);        // ← sólo UNA más (el paso nuevo)
    expect(mailer.enviados).toBe(1);     // ← NO se mandó otro mail
  });

  it('ejecuta DOS veces la misma herramienta si el agente la pide dos veces', async () => {
    // El caso de §4.5: consultar antes y después de modificar
    const tools = espiarTools();
    guionarLLM([
      { tool: 'buscarPedido', args: { id: 8841 } },
      { tool: 'cancelarPedido', args: { id: 8841 } },
      { tool: 'buscarPedido', args: { id: 8841 } },   // la MISMA, a propósito
      { texto: 'Listo, quedó cancelado' },
    ]);

    await correrAgente('msg-2', 'cancelá el 8841');

    expect(tools.llamadas('buscarPedido')).toBe(2);   // ← las DOS se ejecutaron
  });

  it('dos pods en paralelo producen UN solo efecto', async () => {
    const mailer = espiarMailer();
    await Promise.allSettled([
      correrAgente('msg-3', 'avisame por mail'),
      correrAgente('msg-3', 'avisame por mail'),      // el mismo mensaje
    ]);
    expect(mailer.enviados).toBe(1);                   // la idemKey del proveedor
  });

  it('un SIGTERM a mitad no parte ningún bucle', async () => {
    const p = correrAgente('msg-4', 'hacé algo largo');
    await sleep(2_000);
    process.emit('SIGTERM');
    await expect(p).resolves.toBeDefined();            // terminó limpio
  });
});
```

El segundo test es el que protege de que alguien "mejore" la deduplicación
usando `hash(tool+args)` y rompa el razonamiento del agente en silencio.

**Y el game day:** matar un pod a mitad de una generación en producción, en
horario de baja carga, y verificar que el bucle se reanuda, que el costo del
mensaje no se duplica, y que no salió ningún mail de más.

## 7. El costo

1. **Una tabla que crece rápido.** 40.000 mensajes/día × ~8 pasos × trazas de
   LLM de 25 KB ≈ **8 GB/día**. Hay que particionar por día, dropear, y
   probablemente mover el `resultado` grande a S3 con un puntero en la fila
   ([módulo 01](../modules/01-fundamentos/)).
2. **Una escritura más por paso.** 8 `INSERT` por mensaje, en el camino
   crítico. Son ~2 ms cada uno contra llamadas al LLM de 10 segundos: es
   ruido. Pero no es cero.
3. **El versionado del bucle no está resuelto.** Si cambiás la lógica mientras
   hay bucles a mitad, el replay puede ser inválido. El `args_hash` lo detecta;
   resolverlo bien requiere un motor de workflows.
4. **La canonicalización de los argumentos es delicada.** Un `JSON.stringify`
   con las claves en otro orden, un timestamp dentro de los args, o un float
   serializado distinto, y el `args_hash` cambia sin que nada haya cambiado.
   Hay que normalizar de verdad (claves ordenadas, sin campos volátiles).
5. **`max.poll.records = 1` sacrifica throughput por mensaje.** Con bucles de
   10 segundos, cada consumidor hace 0,1 msg/s, así que **la cantidad de
   particiones es tu límite de concurrencia**
   ([módulo 07, D2](../modules/07-kafka/respuestas.md)). Hay que dimensionarlas
   con eso en mente.
6. **Más estado que entender al debuggear.** "¿Por qué este bucle arrancó en el
   paso 6?" es una pregunta nueva que antes no existía.

**Y lo más barato de todo, que es lo primero que hay que hacer:** manejar
`SIGTERM` y poner `terminationGracePeriodSeconds` mayor que el peor bucle. Eso
solo elimina **los 12 eventos diarios de deploy**, que son la mayoría del
problema. La ejecución durable queda para lo que no se puede evitar — el OOM
kill, el spot interrumpido, el nodo drenado — que es mucho menos frecuente.

> **Dos líneas de configuración resuelven el 80% del caso. El otro 20% cuesta
> una tabla y un guard.**

---

## Fuentes

- **Temporal**, *What is durable execution* — el patrón de este caso,
  industrializado: <https://temporal.io/blog/what-is-durable-execution>
- **Temporal**, *Workflow determinism and versioning* — el problema del §5 que
  la versión a mano no resuelve:
  <https://docs.temporal.io/workflows#deterministic-constraints>
- **AWS**, *Step Functions y cargas de trabajo de IA*:
  <https://docs.aws.amazon.com/step-functions/latest/dg/concepts-standard-vs-express.html>
- **Confluent**, *Exactly-once semantics* — qué cubre y qué no:
  <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **Yao, Schick et al.**, *ReAct: Synergizing Reasoning and Acting in Language
  Models* — el bucle que estamos haciendo reanudable:
  <https://arxiv.org/abs/2210.03629>

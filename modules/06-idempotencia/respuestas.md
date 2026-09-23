# Respuestas modelo — Módulo 06

> Abrilo **después** de escribir las tuyas en `mis-respuestas/06.md`.

---

## Bloque A — Conceptos

### A1 — Qué es idempotente

> **Una operación es idempotente si el estado final del sistema es el mismo
> se ejecute una vez o cien.**

La definición que casi todos dan —*"que la segunda vez no haga nada"*— está
mal, y la diferencia importa: una operación puede hacer trabajo cada vez y
seguir siendo idempotente. `UPDATE cuentas SET saldo = 100 WHERE id = 1`
escribe siempre, y el estado final es idéntico.

Y la idempotencia es del **estado**, no de la **respuesta**. Un `DELETE` que
devuelve `204` la primera vez y `404` la segunda **es idempotente**: el estado
del recurso es el mismo. (Aunque en la práctica conviene devolver `204` las dos
veces, porque un cliente que trata el `404` como error va a reintentar o a
mostrar un mensaje raro.)

**Ejemplos que parecen idempotentes y no lo son:**

```ts
// Parece el caso de manual: marcar como leído.
async marcarLeido(id: string) {
  await this.repo.update(id, { leido: true });        // ✅ idempotente
  await this.metricas.increment('mensajes.vistos');   // ❌ ARRUINA TODO
}
```

El segundo `increment` hace que la operación completa no sea idempotente: cada
reintento infla la métrica. El patrón general: **basta con que UNA línea del
handler no sea idempotente para que el handler entero no lo sea.**

Dos más, de los que muerden:

- `PUT /usuarios/1` que además hace `INSERT INTO historial_cambios`. El verbo
  dice idempotente; el código dice que no.
- Un handler que actualiza el estado de la orden (idempotente) **y manda un
  mail** (no). Es exactamente el D2 de este cuestionario.

### A2 — Por qué es necesaria, no opcional

Todo sale del **timeout ambiguo**:

```
A ──── POST /cobrar ────► B
  ◄─────── ??? ──────────    timeout a los 5 s
```

A **no puede distinguir** entre tres casos: la request nunca llegó, B la
procesó bien y se perdió la respuesta, o B todavía está procesando.

Y no es una limitación del stack: en una red asíncrona **no existe** forma de
distinguir un nodo caído de uno lento. Es el mismo hecho detrás de la
imposibilidad de FLP.

Entonces A tiene **dos** opciones, y ninguna es "esperar a estar seguro":

| | Qué hace | Consecuencia |
| --- | --- | --- |
| **No reintentar** | Devuelve error | **Perdés operaciones** que sí ocurrieron |
| **Reintentar** | Manda de nuevo | **Duplicás** operaciones |

No hay tercera opción, porque la información necesaria para elegir bien **no
existe del lado de A**. Por eso la idempotencia no es una buena práctica
opcional: **es lo que convierte "reintentar" en una decisión segura**. Sin
ella, cada reintento es una apuesta.

La receta completa:

```
at-least-once  +  operación idempotente  =  "effectively once"
```

### A3 — Las tres formas

**(a) Diseñar la operación para que lo sea** — mandar **estado deseado** en
vez de **transición**.

```
❌ POST /carrito/items/123/incrementar
✅ PUT  /carrito/items/123  { cantidad: 3 }
```

*No sirve cuando:* la operación es inherentemente una **creación** (no podés
expresar "creá una orden" como estado absoluto sin que el cliente invente el
id — que es, de hecho, una solución válida: que el cliente genere el ULID) o
un **efecto externo** ("mandá el mail" no tiene estado absoluto).

**(b) Deduplicación por clave** — `Idempotency-Key`, `eventId`, `messageId`,
con un `UNIQUE` que serialice.

*No sirve cuando:* el efecto está **fuera de tu transacción** (fila 4 de
`idempotencia.ts`), o cuando la clave no es determinística.

**(c) Máquina de estados** — la transición inválida se rechaza sola.

```sql
UPDATE ordenes SET estado = 'PAGADA'
 WHERE id = $1 AND estado = 'PENDIENTE';   -- la segunda vez: 0 filas
```

*No sirve cuando:* la operación **no deja rastro en la entidad** (mandar el
mail), o cuando **dos operaciones distintas** hacen la misma transición y hay
que distinguirlas (dos pagos parciales que ambos llevan de `PENDIENTE` a
`PAGADA`).

En la práctica se combinan: (c) para el estado del dominio, (b) para el
efecto externo, y (a) siempre que el diseño lo permita.

### A4 — ¿Existe exactly-once?

**De punta a punta, no.** Y el motivo es A2: el emisor no puede saber si el
receptor procesó el mensaje. Cualquier protocolo que lo intente necesita un
ack, y **el ack también se puede perder**. No es una limitación de
implementación: es información que no existe.

Lo que sí existe, con nombre preciso:

- **"Effectively once"** = at-least-once + procesamiento idempotente. Los
  duplicados **llegan** y **no producen efecto**. Es lo que se construye.
- **Exactly-once de Kafka (EOS)**: real y bien hecho. Con productor
  idempotente y transacciones, el ciclo *consumir → transformar → producir*
  es atómico: el offset de entrada y los mensajes de salida se commitean
  juntos.

**Lo que NO cubre, y es la mitad de la respuesta:** en cuanto el efecto sale
de Kafka —tu `INSERT` en Postgres, tu `POST` a Stripe, tu llamada al LLM— la
garantía se termina. `entrega.ts` lo muestra crudo: con EOS activado, los
duplicados dentro de Kafka bajan a cero y **las llamadas al LLM de más siguen
siendo 30.000 por día, USD 219.000 al año**.

> *"Activamos exactly-once"* no significa que tus efectos ocurran una vez.
> Significa que el mensaje no se duplica entre topics de Kafka.

La frase que cierra: **"la garantía no vive en el broker: vive en el efecto."**

### A5 — Idempotente vs seguro

- **Seguro (*safe*)**: no modifica el estado. `GET`, `HEAD`, `OPTIONS`.
- **Idempotente**: repetirlo deja el mismo estado. `GET`, `HEAD`, `PUT`,
  `DELETE`.

| Verbo | Safe | Idempotente |
| --- | --- | --- |
| `GET` / `HEAD` | ✅ | ✅ |
| `PUT` | ❌ | ✅ |
| `DELETE` | ❌ | ✅ |
| `POST` | ❌ | ❌ |
| `PATCH` | ❌ | Depende del patch (`{"cantidad": 3}` sí; `{"$inc": 1}` no) |

**Todo lo seguro es idempotente; lo inverso no.**

**Por qué un `PUT` puede no serlo en la práctica:** porque la tabla describe
**la semántica que deberías implementar**, no lo que tu código hace. Un `PUT`
deja de ser idempotente si además escribe un historial, incrementa un
contador, dispara una notificación en cada llamada, o si el servidor genera
parte del recurso (un `updated_at`, un id nuevo). **El verbo es una promesa
tuya, no una garantía del protocolo.**

### A6 — Cuatro garantías por encima de "eventual"

| Garantía | Qué promete | Síntoma cuando falta |
| --- | --- | --- |
| **Read-your-writes** | Ves tus propias escrituras | *"Guardé y no se guardó"* (módulo 05, C4) |
| **Monotonic reads** | El tiempo no va para atrás | Ves un comentario, refrescás y **desapareció** |
| **Causal / consistent prefix** | Si A causó B, nadie ve B sin A | Ves **la respuesta antes que la pregunta** en un chat |
| **Linealizable** | Como si hubiera una sola copia | Dos usuarios ven valores distintos como "el actual"; **no podés construir un lock encima** |

Dos observaciones que suman:

1. **Son por operación, no por sistema.** El perfil que acabás de editar
   necesita read-your-writes; el listado de productos no. En el mismo
   Postgres, leer del primario es fuerte y leer de la réplica es eventual.
2. **Monotonic reads es la que más se nota** y la más fácil de arreglar: pasa
   cuando dos lecturas caen en réplicas con lag distinto. Se resuelve pegando
   cada sesión a la misma réplica (*sticky reads*).

> **Rúbrica bloque A**
> - **Mid:** define idempotencia como "la segunda vez no hace nada" y sabe que
>   `GET` y `PUT` son idempotentes.
> - **Senior:** define por estado final, parte del timeout ambiguo, y sabe que
>   exactly-once de punta a punta no existe.
> - **Staff:** distingue safe de idempotente, sabe exactamente qué cubre EOS de
>   Kafka y qué no, y trata las garantías de consistencia como decisión por operación.

---

## Bloque B — La clave de idempotencia

### B1 — Quién la genera

**El cliente.** Y es contraintuitivo, así que conviene justificarlo bien: si
la generara el servidor, **el cliente no tendría forma de repetirla al
reintentar** — que es exactamente para lo que sirve. La clave identifica una
**intención de negocio**, y la intención nace en el cliente.

**Si un interceptor de reintentos genera un `uuid()` nuevo en cada intento, la
protección no existe.** Cada reintento es, para el servidor, una intención
nueva y legítima: tres intentos son tres pagos. Y lo peor es que **el sistema
parece correcto**: la tabla de claves se llena, el `UNIQUE` funciona, los
tests pasan. Simplemente no protege de nada.

Es el bug más común de esta sección, y aparece por un motivo de diseño: la
clave se genera **donde se arma la request HTTP** en vez de **donde el usuario
expresa la intención**.

La regla:

> **La clave se crea cuando el usuario aprieta el botón, no cuando se
> construye el request.** Se persiste en el cliente (para sobrevivir a que se
> cierre la app) y se reusa en todos los reintentos de esa intención.

```ts
// ❌ el interceptor la genera por intento
axios.interceptors.request.use((c) => { c.headers['Idempotency-Key'] = uuid(); return c; });

// ✅ nace con la intención y se reusa
const intento = { key: crypto.randomUUID(), payload };
await storage.setItem(`pago-pendiente`, JSON.stringify(intento));  // sobrevive al cierre
await reintentarConBackoff(() => api.pagar(intento.payload, intento.key));
```

### B2 — El alcance

`(tenant o usuario, endpoint, clave)`. Nunca la clave a secas.

**Por qué es un problema de seguridad y no sólo de corrección:** la tabla de
claves guarda **la respuesta original**. Si el alcance no incluye al usuario y
alguien acierta —o reusa— una clave ajena, **le devolvés la respuesta de otro
tenant**: el comprobante de pago de otra persona, con su monto, su id de
orden y posiblemente sus datos. Es una fuga de datos, no un bug de negocio.

El riesgo es bajo con UUIDs aleatorios, y **alto** en cuanto alguien usa
claves "legibles" (`orden-1`, `${userId}-${timestamp}`), que es lo que pasa en
cuanto un cliente móvil o una integración las construye a mano.

Y sin el **endpoint** en el alcance, la misma clave sirve para `POST /pagos` y
para `POST /reembolsos`, y el segundo recibe la respuesta guardada del primero.

### B3 — Qué devolver en cada caso

| Caso | Respuesta |
| --- | --- |
| **(a) Clave nueva** | Procesás normalmente. `201` / `200` con el resultado |
| **(b) `COMPLETED`, mismo request** | **La respuesta original guardada**, con su status original. Conviene agregar un header tipo `Idempotent-Replay: true` para que el cliente sepa |
| **(c) `IN_PROGRESS`** | **`409 Conflict`** + `Retry-After`. "Hay una request en curso con esta clave" |
| **(d) Request distinto** | **`422`** (o `400`). **Nunca** la respuesta guardada |
| **(e) El intento anterior falló** | **Depende de cómo falló** (ver abajo) |

**(d) es el que separa una implementación seria de una de juguete.** Si
alguien manda la misma clave con `{monto: 100}` y después con `{monto: 5000}`,
devolverle la respuesta del primero **es peor que fallar**: le confirmás un
pago de 5.000 que nunca ocurrió. Por eso se guarda el **hash del request** y
se compara.

**(e) merece el matiz** que casi nadie da:

- Falló con **4xx determinístico** (validación, saldo insuficiente): guardás
  el error y lo **repetís**. Reintentar no va a cambiar nada, y repetir la
  respuesta es coherente.
- Falló con **5xx o timeout** (transitorio): **liberás la clave** (o la marcás
  reintentable) para que el reintento pueda ejecutarse de verdad. Si la
  dejaras `COMPLETED` con el error, el cliente nunca podría recuperarse de una
  caída momentánea.

### B4 — Dónde vive la fila `IN_PROGRESS`

**En su propia transacción corta, commiteada antes de empezar el trabajo.**

Si la insertás dentro de la transacción larga que procesa el pago:

1. La segunda request hace su `INSERT` sobre la misma clave única y **se queda
   bloqueada** — Postgres la hace esperar a que la primera commitee o aborte,
   porque hasta entonces no sabe si la clave va a existir.
2. Con un pago de 4 segundos, esa segunda request tiene **una conexión del
   pool tomada 4 segundos sin hacer absolutamente nada**.
3. Bajo carga, con reintentos agresivos, eso **agota el pool** y se lleva
   puestos endpoints que no tienen nada que ver (módulo 01, C2).
4. Y encima **no podés devolver `409`**, porque no ves la fila `IN_PROGRESS`:
   está en una transacción sin commitear.

Con la transacción corta: la segunda request ve `IN_PROGRESS` al instante,
devuelve `409` en 2 ms y **libera la conexión**.

El costo de hacerlo bien: si el proceso muere después de marcar `IN_PROGRESS`
y antes de terminar, la clave queda trabada. Se resuelve con un **timeout**
(las `IN_PROGRESS` de más de N minutos se consideran abandonadas) y un job que
las limpie o las marque para reintento.

### B5 — Cuánto duran

**24 horas es el estándar** (es lo que usa Stripe).

- **Muy corto** (minutos): un cliente móvil que recupera conectividad dos
  horas después reintenta con una clave que ya expiró → **duplica**. Y los
  clientes móviles reintentan tarde: es su caso normal, no el excepcional.
- **Muy largo** (meses): la tabla crece sin control, el índice deja de entrar
  en RAM (módulo 05, B4) y cada `INSERT` se pone lento.

**Cómo limpiarlas sin crear otro problema:** no con un `DELETE ... WHERE
created_at < ...` sobre una tabla caliente — eso genera bloat masivo y un
`VACUUM` pesado (módulo 05, A6). **Particionás por día y hacés `DROP TABLE`
de la partición vieja**, que es instantáneo.

Es el mismo patrón del `outbox`: una tabla de alta rotación se particiona y se
dropea, no se borra fila por fila.

> **Rúbrica bloque B**
> - **Mid:** el cliente genera la clave, y la clave existente devuelve lo mismo.
> - **Senior:** ve el bug del interceptor que regenera, scopea por tenant y
>   endpoint, devuelve 409 en `IN_PROGRESS` y 422 con payload distinto.
> - **Staff:** explica por qué `IN_PROGRESS` necesita transacción propia (el
>   pool), distingue fallos 4xx de 5xx para la reutilización, y limpia por particiones.

---

## Bloque C — Locks y coordinación

### C1 — Lock distribuido con Redis, y su crítica

```ts
async function conLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const token = crypto.randomUUID();
  const ok = await redis.set(`lock:${key}`, token, 'NX', 'PX', ttlMs);
  if (!ok) return null;                       // otro lo tiene

  try {
    return await fn();
  } finally {
    // Liberar SÓLO si sigue siendo nuestro. Tiene que ser ATÓMICO.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1]
         then return redis.call("del", KEYS[1]) else return 0 end`,
      1, `lock:${key}`, token,
    );
  }
}
```

**Las tres formas en que falla — y la autocrítica es lo que evalúan:**

1. **El TTL contra la duración del trabajo.** Si `fn()` tarda más que el TTL
   —por una pausa de GC, por un pico de latencia, porque el trabajo creció—
   **el lock expira mientras seguís trabajando** y otro lo toma. Los dos
   corren a la vez. El `finally` con Lua evita que borres el lock ajeno, pero
   **no evita la ejecución concurrente**. Es C2.
2. **Failover de Redis.** La replicación de Redis es **asíncrona**: el primario
   confirma el `SET NX`, se cae antes de replicar, la réplica promueve sin esa
   clave, y **otro cliente toma el mismo lock**. Los dos lo tienen, los dos
   creen que son el único. Redlock nació para esto y aun así no resuelve (1).
3. **El proceso muere con el lock tomado.** Nadie puede trabajar hasta que
   expire el TTL. En un cron mensual eso significa **que ese mes no se
   ejecuta** — cambiaste "ejecutar dos veces" por "no ejecutar", que puede ser
   peor y es mucho más difícil de detectar (módulo 03, C1).

Cuarta, menor pero real: **`crypto.randomUUID()` como token es correcto; usar
el hostname o el pid, no** — un pod reiniciado con el mismo nombre podría
borrar el lock de su encarnación anterior.

### C2 — TTL de 10 s, pausa de GC de 15 s

**(a) La secuencia:**

```
t=0     Cliente 1: SET NX PX 10000  -> OK, tiene el lock
t=0,8   Cliente 1: empieza a escribir... y entra en una pausa STOP-THE-WORLD
t=10    Redis expira el lock solo. Nadie avisa a nadie.
t=10,1  Cliente 2: SET NX PX 10000  -> OK, "tiene el lock"
t=10,9  Cliente 2: escribe el resultado ✅
t=15,8  Cliente 1: DESPIERTA. Para él no pasó el tiempo. Cree que tiene el
        lock, y escribe. 💥 Dos escrituras sobre el mismo recurso.
```

**El cliente 1 no hizo nada mal.** Ningún proceso puede saber cuánto tiempo
pasó mientras estaba congelado. Y esto no es exótico: una pausa de
*stop-the-world* de varios segundos en un heap grande es rutina, igual que una
VM suspendida o una red congelada.

**(b) ¿Lo arregla Redlock? No.** Redlock hace más robusta la **adquisición**
del lock frente a la caída de un nodo (el fallo 2 de C1). Pero acá el cliente 1
**adquirió el lock correctamente**. El problema está en lo que pasa **después**:
entre "tengo el lock" y "escribo" pasó tiempo que el cliente no puede medir.

Ningún algoritmo de locking arregla eso, porque la falla no está en el lock:
está en la suposición de que el reloj del cliente y el del lock avanzan
juntos. Con pausas de GC, suspensión de VMs o relojes que saltan, no avanzan
juntos. **Es el centro de la crítica de Kleppmann.**

**(c) ¿Un TTL más largo?** Tampoco, y es importante entender por qué: sólo
cambiás un fallo por el otro. Con TTL de 60 s el escenario es menos probable —
pero cualquier pausa lo suficientemente larga lo reproduce — y a cambio, **si
el proceso muere, nadie trabaja durante 60 segundos**. Estás eligiendo entre
dos fallas, no arreglando ninguna.

**(d) Lo que lo arregla: fencing tokens** (C3). O directamente que el recurso
tenga una operación atómica que haga innecesario el lock.

### C3 — Fencing token

Cada otorgamiento del lock entrega un **número estrictamente creciente**. El
recurso protegido **rechaza toda escritura con un token menor al último que
vio**.

```
Cliente 1 toma el lock  -> token 33   [congelado]
Cliente 2 toma el lock  -> token 34   escribe con 34  ✅ (el recurso anota 34)
Cliente 1 despierta     -> escribe con 33  ❌ RECHAZADO (33 < 34)
```

**Dónde vive la lógica: EN EL RECURSO, no en el lock.** Ésta es la parte que
casi nadie dice, y es la que hace que el concepto sea útil o decorativo. Si tu
base, tu bucket o tu API **no comparan tokens**, no tenés fencing — por más
que tu librería de locks te devuelva un número.

**La relación con el módulo 05:** en Postgres, el fencing se escribe así:

```sql
UPDATE recurso SET datos = $1, version = $2
 WHERE id = $3 AND version < $2;
```

Que es, exactamente, **el lock optimista**. **Fencing token y columna de
versión son el mismo mecanismo con dos nombres**, según si el número lo emite
un servicio de locks o la propia fila.

Y el corolario incómodo, que conviene decir: **si el recurso puede comparar
versiones, muchas veces ya no necesitás el lock.** La comparación sola te da
la corrección; el lock queda como optimización para no desperdiciar trabajo.

(Nota práctica: durante años S3 no permitía nada de esto, y por eso "proteger
un archivo de S3 con un lock de Redis" era estructuralmente incorrecto. Hoy S3
soporta escrituras condicionales, lo que permite implementar algo equivalente.
Antes de diseñar, verificá qué ofrece **tu** almacén.)

### C4 — Eficiencia o corrección

**La pregunta va primero porque determina si el lock alcanza o no**, y ninguna
elección de tecnología cambia esa respuesta.

| | **Eficiencia** | **Corrección** |
| --- | --- | --- |
| Qué pasa si el lock falla | Se hace el trabajo dos veces. Se desperdicia | **Se corrompe algo** |
| ¿Alcanza un lock distribuido? | **Sí**, Redis está perfecto | **No. Nunca** |
| Qué hace falta además | Nada | Fencing, u operación atómica en el recurso |

**Ejemplos de los módulos anteriores:**

- **Eficiencia** — el *single-flight* del módulo 04: el lock evita que 240
  requests hagan la misma query. Si falla y dos van a la base, se desperdició
  una query y **no pasó nada**. Redis alcanza y sobra.
- **Corrección** — el `@Cron` que factura del módulo 03: si dos corren,
  **facturás dos veces**. Y por eso la solución real de ese módulo **no fue un
  lock mejor**: fue un `UNIQUE (cliente, periodo)`, o sea una operación atómica
  en el recurso. Exactamente lo que dice esta tabla.
- **Corrección** — procesar un archivo y escribir el resultado: si dos lo
  hacen, se pisan. Necesitás fencing en el destino, o una escritura
  condicional.

**La regla que se lleva uno:** si la respuesta es "corrección" y tu diseño se
apoya **sólo** en el lock, tiene un bug que va a aparecer el día de más carga
del año — porque es el día con más pausas de GC.

### C5 — Que un job corra en una sola instancia

| Opción | Cómo | Cuándo |
| --- | --- | --- |
| **1. Sacarlo del proceso replicado** | `CronJob` de k8s (`concurrencyPolicy: Forbid`), o EventBridge → cola → un consumidor | **El default.** Módulo 03, C1 |
| **2. Advisory lock de Postgres** | `SELECT pg_try_advisory_lock(hashtext('job'))` | Ya tenés Postgres y no querés tocar infra |
| **3. etcd / ZooKeeper / Consul** | Lease + watch, con consenso Raft/ZAB | Cuando la corrección importa de verdad y hay presupuesto operativo |

**Por qué el advisory lock le gana al de Redis:**

1. **No tiene TTL que calibrar.** Es el problema central de C1 y C2. El
   advisory lock de sesión **se libera cuando la conexión se cierra**, y
   Postgres detecta la conexión muerta. No hay que adivinar cuánto va a tardar
   el trabajo.
2. **Vive en el mismo sistema transaccional que tus datos.** No hay una
   segunda fuente de verdad que pueda desincronizarse con la primera.
3. **Cero infraestructura nueva.** Sin un Redis más que operar, monitorear y
   que se pueda caer.

Sus límites, que hay que nombrar: ocupa una conexión mientras dure el job, y
con PgBouncer en modo `transaction` hay que usar la variante `_xact` o saltear
el pooler. Y la detección de la conexión muerta **no es instantánea** (un
socket a medio cerrar puede tardar), así que la ventana de dos titulares
existe igual, sólo que es más chica.

**¿Sigue haciendo falta que el job sea idempotente? SÍ, siempre.** Por tres
motivos:

1. Ningún mecanismo de elección de líder garantiza que **nunca** haya dos: en
   una partición de red o durante un failover, dos instancias pueden creerse
   líderes brevemente. Es C2 otra vez.
2. El job puede **fallar a la mitad y reintentarse**, con o sin líder.
3. Alguien lo va a correr a mano para "arreglar algo". Siempre pasa.

> **Rúbrica bloque C**
> - **Mid:** escribe el `SET NX PX` y libera con Lua.
> - **Senior:** critica su propio lock (TTL vs duración, failover, proceso
>   muerto) y explica el escenario de la pausa de GC.
> - **Staff:** sabe que el fencing vive en el recurso, lo identifica con el
>   lock optimista, y usa la pregunta eficiencia/corrección para decidir antes
>   de elegir tecnología.

---

## Bloque D — Aplicado

### D1 — `POST /pagos` con el 4G cortado

La cadena completa. **Si falta un eslabón, la cadena no protege**:

| # | Dónde | Qué tiene que existir | Si falta... |
| --- | --- | --- | --- |
| 1 | **Cliente** | La clave se genera **al apretar el botón**, no al armar el request | Cada reintento es una intención nueva → **duplica** |
| 2 | **Cliente** | La clave se **persiste en disco** (no en memoria) | Si la app se cierra y el usuario reintenta, clave nueva → **duplica** |
| 3 | **Cliente** | Reintentos con backoff + jitter y un límite | Sin backoff, amplificás la caída (módulo 08) |
| 4 | **Red** | El gateway/CDN **reenvía el header** `Idempotency-Key` | Algunos proxies filtran headers desconocidos → el server no la ve |
| 5 | **Servidor** | Exige la clave (`400` si falta) y la **scopea** por tenant+endpoint | Sin exigirla, un cliente viejo la omite y duplica en silencio |
| 6 | **Servidor** | `IN_PROGRESS` en transacción propia + hash del request | Pool agotado (B4) y claves reusadas con otro payload (B3d) |
| 7 | **Servidor** | La marca y el efecto interno, en **la misma transacción** | Muere en el medio → duplica |
| 8 | **Proveedor** | Clave de idempotencia **determinística** derivada del negocio | Muere entre cobrar y commitear → **cobro duplicado sin registro** |
| 9 | **Operación** | Job de **reconciliación** que compara los dos lados | Los casos residuales no los detecta nadie |

**Lo importante de esta pregunta es el punto 8**, porque es el que casi todos
olvidan: podés tener los siete primeros impecables y aun así duplicar, como
muestra la fila 4 de `idempotencia.ts`. **La idempotencia es de punta a punta:
una cadena con ocho eslabones buenos y uno malo no es idempotente.**

Y el punto 1 es el que más se rompe en la práctica, porque el bug **no se ve**:
todo el mecanismo está implementado y correcto, sólo que la clave cambia en
cada intento.

### D2 — El consumer que parece correcto

**(a) Los dos bugs:**

**Bug 1 — race entre el `SELECT` y el `save`.** Si dos consumers procesan el
mismo evento a la vez (rebalance, reintento, dos pods), **los dos hacen el
`findOne`, los dos no encuentran nada, y los dos mandan el mail**. Es el lost
update del módulo 05 y la fila 2 de `idempotencia.ts`.

**Bug 2 — el efecto es externo y ocurre ANTES de la marca.** Aunque arregles
el bug 1, si el proceso muere **después de mandar el mail y antes del
`save`**, al reprocesar el evento la marca no existe y **manda el mail de
nuevo**. Y no hay transacción que los una: el proveedor de mail no participa
de tu `BEGIN/COMMIT`.

**(b) Arreglo del bug 1 — que chequear y marcar sean una sola operación:**

```ts
const insert = await this.dataSource.createQueryBuilder()
  .insert().into(ProcessedEvent)
  .values({ eventId: ev.eventId })
  .orIgnore()                                  // ON CONFLICT DO NOTHING
  .execute();

if (insert.identifiers.length === 0) return;   // duplicado: nos vamos
```

El que serializa es el índice único, por debajo del nivel de aislamiento
(módulo 05, C2).

**(c) Por qué el bug 2 no se arregla con una transacción:** porque **el
proveedor de mail no es transaccional**. Podés envolver todo en un
`BEGIN/COMMIT` y el mail va a salir igual en el momento en que llamás a la
API; si después el `COMMIT` falla, el mail ya voló. Es el problema de la doble
escritura del módulo 02, del lado del consumidor.

**Qué hacer — y la respuesta buena es reconocer el patrón:** convertir el
efecto externo en una **escritura interna**, y dejar el envío para un proceso
aparte. Es el **outbox**, aplicado del lado del consumidor:

```ts
@EventPattern('order.created')
async handle(@Payload() ev: OrderCreated) {
  await this.dataSource.transaction(async (tx) => {
    const insert = await tx.createQueryBuilder()
      .insert().into(ProcessedEvent).values({ eventId: ev.eventId }).orIgnore().execute();
    if (insert.identifiers.length === 0) return;      // ya procesado

    // El mail NO se manda acá: se ENCOLA, en la misma transacción.
    await tx.save(OutboxEvent, {
      topic: 'mail.enviar',
      dedupKey: `order-confirmada-${ev.orderId}`,     // determinística
      payload: { to: ev.email, template: 'orden-confirmada' },
    });
  });
}
```

Ahora la marca y el "efecto" (la fila del outbox) **sí** están en la misma
transacción. El worker que manda el mail tiene su propio reintento y su propia
deduplicación por `dedupKey` — y si el proveedor soporta claves de
idempotencia, se la pasás.

Las alternativas, con su costo honesto:

- **Marcar ANTES de mandar**: cambiás "puede mandar dos veces" por "puede no
  mandar". Para un mail de confirmación suele ser peor no mandarlo; para una
  notificación de cobro, mandarlo dos veces es peor. **Es una decisión de
  producto, no técnica.**
- **Clave de idempotencia del proveedor**, si la soporta. Muchos proveedores de
  mail no la tienen, y ahí volvés al outbox.

### D3 — El consumer idempotente que llama a un LLM

**(a) No, no sigue estando todo bien.** La deduplicación protege el **estado**
—no vas a tener dos filas en Postgres— pero **no protege el costo**, por dos
motivos distintos:

1. Si la llamada al LLM ocurre **antes** del chequeo de deduplicación (que es
   lo natural: primero generás, después guardás), pagás los tokens en cada
   reproceso aunque después descartes el resultado.
2. Aunque chequees primero, si el pod muere **después** de llamar al LLM y
   antes de commitear, el reintento vuelve a llamar. Es la fila 4 de
   `idempotencia.ts` con el LLM en el lugar de Stripe.

**"Idempotente" significa que el estado final es el mismo. No significa que no
gastaste plata en el camino.**

**(b) El costo:** con 500 msg/s, commit cada 5 s y 12 rebalances por día:

```
2.500 mensajes por evento × 12 eventos/día = 30.000 duplicados/día
30.000 × USD 0,02 × 365 = USD 219.000 por año
```

**(c) La solución**, en capas:

1. **Chequear la deduplicación PRIMERO y barato**, antes de tocar el LLM. Un
   `SET NX` en Redis cuesta microsegundos y es lo primero de la función.
2. **Cachear la respuesta del LLM por `eventId`.** Si el reproceso encuentra
   una respuesta guardada, la reusa en vez de volver a generar. Esto cubre el
   caso 2: el resultado sobrevive aunque la transacción se haya revertido.
3. **Bajar la ventana de reproceso**: commits manuales por lote en vez de
   `auto.commit.interval` de 5 s. Reduce los duplicados de 2.500 a decenas por
   evento, y es un cambio de configuración.
4. **Alertar sobre la tasa de reproceso.** Si un rebalance en loop
   (módulo 02, C3) te hace reprocesar sin parar, el costo se dispara **y la
   única métrica que lo muestra es la factura**.
5. Y el punto de diseño: **poner la llamada cara lo más tarde posible** en el
   handler, después de todas las validaciones y de la deduplicación.

`entrega.ts` tiene la tabla completa, incluida la fila que muestra que **el
exactly-once de Kafka no cambia nada de esto**: el mensaje deja de duplicarse
entre topics, y la llamada al LLM ocurre igual.

### D4 — Idempotencia del bucle de un agente

**La clave de cada tool-call:**

```ts
const claveDelPaso = sha256(JSON.stringify({
  messageId,          // la intención del usuario
  stepIndex,          // EL NÚMERO DE PASO DEL BUCLE  <-- clave
  toolName,
  args: canonicalizar(args),   // orden de claves estable, sin timestamps
}));
```

**Cómo hacer que reanudar desde el paso 3 no re-ejecute 1 y 2:** persistir
cada paso apenas termina, con un índice único:

```sql
CREATE TABLE agent_steps (
  message_id  uuid NOT NULL,
  step_index  int  NOT NULL,
  tool_name   text NOT NULL,
  args_hash   text NOT NULL,
  result      jsonb,
  PRIMARY KEY (message_id, step_index)
);
```

Al reanudar, el worker **lee los pasos ya completados y los reproduce desde la
tabla** en vez de ejecutarlos. El bucle pasa a ser **reanudable**: el pod se
puede reciclar en cualquier momento y el trabajo continúa donde estaba, sin
repetir ningún efecto y sin volver a pagar ningún token.

**Si el LLM decide llamar la misma herramienta dos veces a propósito:** se
ejecuta **dos veces, y está bien**. Por eso la clave incluye `stepIndex`: son
dos pasos distintos del razonamiento, aunque la herramienta y los argumentos
coincidan. Si la clave fuera sólo `hash(toolName + args)`, deduplicarías una
acción que el agente pidió deliberadamente — por ejemplo, consultar el estado
de algo **antes y después** de modificarlo, que es un patrón completamente
normal.

**Es el error de diseño más sutil de esta sección: deduplicar de más es tan
bug como deduplicar de menos.**

**Qué patrón estás reimplementando: ejecución durable** (*durable execution*)
— exactamente lo que hacen Temporal, AWS Step Functions o Restate. La idea es
la misma: **persistir el resultado de cada paso determinístico para poder
retomar sin repetir efectos**. Lo que esos motores agregan encima es el
manejo de timers, la versión del código entre reanudaciones, y la garantía de
determinismo del replay.

Decir esto —"estoy construyendo a mano un motor de workflows durables; si esto
crece, la pregunta es si conviene adoptar uno"— es exactamente la clase de
observación que separa a un senior de un staff en una entrevista de diseño.

> **Rúbrica bloque D**
> - **Mid:** encuentra el race del `findOne` y lo arregla con `ON CONFLICT`.
> - **Senior:** ve que el efecto externo no se arregla con una transacción,
>   propone el outbox del lado del consumidor, y cuantifica el costo del LLM.
> - **Staff:** arma la cadena completa de D1 y señala el eslabón del proveedor,
>   incluye `stepIndex` en la clave del agente, y reconoce la ejecución durable.

---

## Fuentes para profundizar

- **Martin Kleppmann**, *How to do distributed locking* — la crítica a Redlock,
  los fencing tokens, y el mejor diagrama del problema:
  <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Salvatore Sanfilippo**, la respuesta de Redis:
  <http://antirez.com/news/101> (vale leer las dos)
- **Stripe**, *Idempotent requests* — el contrato de referencia:
  <https://docs.stripe.com/api/idempotent_requests>
- **AWS Builders' Library**, *Making retries safe with idempotent APIs*:
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
- **Confluent**, *Exactly-once semantics in Kafka* — qué cubre y qué no:
  <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **Kleppmann**, *DDIA* cap. 9 (consistencia y consenso) y cap. 11 (*Exactly-once
  message processing*).
- **Temporal**, *What is durable execution* — el patrón de D4, industrializado:
  <https://temporal.io/blog/what-is-durable-execution>

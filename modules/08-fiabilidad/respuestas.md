# Respuestas modelo — Módulo 08

> Abrilo **después** de escribir las tuyas en `mis-respuestas/08.md`.

---

## Bloque A — Conceptos

### A1 — Degradado es peor que caído

**Un servicio caído devuelve error rápido.** Tu timeout lo absorbe en
milisegundos, el circuit breaker se abre, el fallback entra, y el resto de tu
sistema sigue andando. El daño está acotado al feature que dependía de él.

**Un servicio degradado te retiene recursos.** Y eso lo cambia todo:

1. **Por la Ley de Little**, si la latencia pasa de 50 ms a 30 s con 100 req/s,
   la concurrencia en vuelo pasa de 5 a **3.000**. Cada una de esas requests
   tiene tomada una conexión, un socket, memoria y, muy probablemente, una
   conexión del pool de la base.
2. **El fallo se propaga por el recurso compartido**, no por la dependencia:
   endpoints que **no usan** ese servicio empiezan a fallar porque no
   consiguen una conexión. En la simulación, `/checkout` cae al 26% de éxito
   sin tocar jamás el servicio roto.
3. **Los health checks pasan.** Responde, aunque sea lento. Sigue en el
   balanceador recibiendo su cuota (módulo 03, B1: el health check dice
   "vivo/muerto", el balanceo necesita "rápido/lento").
4. **El breaker puede no abrirse**, porque técnicamente no está fallando:
   está respondiendo tarde. Si tu breaker sólo cuenta errores y no latencia,
   no se entera.

La frase que resume: **caído es un fallo local; lento es un fallo que se
expande.**

### A2 — Elegir un timeout

```
timeout = p99 de la dependencia × 1,5 a 2
```

No un número redondo: un número derivado de cómo se comporta realmente esa
dependencia. Si su p99 es 250 ms, 400-500 ms es razonable. 100 ms convierte
el 5% de tu tráfico sano en errores; 30 s no te protege de nada.

**El costo explícito:** un timeout **cambia latencia de cola por tasa de
error**. En la simulación del módulo 02, bajar el timeout mejoró el p99 de
1.900 ms a 300 ms **y bajó la disponibilidad**, porque rechazó requests que
iban a salir bien. Por eso **un timeout sin reintento es media solución**: te
arregla el p99 y te empeora los errores.

**Los cuatro timeouts de una llamada a la base:**

1. **Connect** — establecer TCP/TLS. Es el único que la gente configura.
2. **Socket / read** — esperar bytes. Queda infinito casi siempre.
3. **Request total** — la operación completa, incluyendo reintentos internos
   del driver. Muchos clientes ni lo ofrecen.
4. **Pool acquire** — conseguir una conexión del pool. **Es el que delata la
   saturación** y casi nadie lo mide: tu query tarda 12 ms y la request tarda
   3 s porque estuvo 2,99 s esperando una conexión (módulo 01, C1).

Y un quinto que no es del cliente: **`statement_timeout` en Postgres**. Sin
él, tu app corta a los 5 s y **la query sigue corriendo del otro lado**,
ocupando una conexión y bloqueando el `VACUUM` (módulo 05, A6).

### A3 — Backoff con jitter

**El mecanismo:** cuando una dependencia se cae, **todos** sus clientes fallan
en el mismo instante. Sin jitter, todos calculan **la misma espera**
(`base × 2^intento`) y **vuelven todos juntos**.

> El backoff sin jitter no desparrama la carga: la mueve un poco más tarde,
> intacta. Cambia *cuándo* llega el pico, no *que haya* un pico.

En la simulación, el pico de reintentos es idéntico al de no tener backoff
(99x la capacidad), sólo que 1 segundo después. Y las consecuencias son
peores de lo que parece: cada oleada se estrella entera contra la capacidad,
se atiende la misma fracción chica, y el resto rebota — hasta que **el 88% de
los clientes agota sus intentos y se rinde**.

```ts
const espera = Math.random() * Math.min(TECHO, BASE * 2 ** intento);  // full jitter
```

Es la misma idea que el TTL con jitter del módulo 04. **El problema nunca es
la espera: es la sincronización.**

### A4 — Retry budget

Un **retry budget** limita los reintentos como **fracción del tráfico
exitoso**, a nivel del cliente completo: *"los reintentos no pueden superar el
10% de las requests que están saliendo bien"*.

**Lo que resuelve y el contador no puede:**

> **Una request individual no sabe cuántas OTRAS requests están reintentando
> al mismo tiempo.**

"3 intentos por request" se comporta de forma opuesta a lo que necesitás:

- Cuando **una** request falla (un hipo transitorio), 3 intentos es
  perfecto y el costo es nulo.
- Cuando **todas** fallan (la dependencia se cayó), esos mismos 3 intentos
  **triplican la carga** sobre un servicio que ya no da abasto. El mecanismo
  pensado para la resiliencia se convierte en el ataque.

El budget es **antifrágil al revés**: cuando el sistema está sano casi no se
usa; cuando todo falla, el tráfico exitoso cae, el presupuesto cae con él, y
**los reintentos se apagan solos**. Corta el lazo de realimentación positiva
que produce el fallo metaestable — es la defensa de A7.

Lo implementan Envoy, Finagle y gRPC. Es estrictamente mejor que el contador,
y casi nadie lo usa.

### A5 — Circuit breaker

**CLOSED** (todo pasa, contando fallos) → **OPEN** (se rechaza sin intentar) →
**HALF-OPEN** (pasan unas pocas de prueba) → CLOSED si andan, OPEN si no.

**¿A quién protege? A vos.** Y es la respuesta que distingue a alguien que
entendió el patrón: el breaker evita que el 100% de tus recursos quede
esperando a algo que ya sabés que no va a responder. Que de paso le saques
carga de encima a la dependencia mientras se recupera es un **efecto
secundario agradable**, no el objetivo.

**Los cuatro errores:**

1. **Umbral por cantidad en vez de por tasa.** "10 fallos" se alcanza igual
   con 10 de 10 que con 10 de 100.000. Usá **tasa + volumen mínimo**.
2. **Abrir por errores de negocio.** Un `404` o un `422` no son fallos de la
   dependencia: la dependencia funcionó perfecto y te dijo que no. Sólo
   cuentan timeouts, `5xx` y errores de conexión.
3. **Sin fallback.** Un breaker abierto sin plan de degradación convierte
   "lento" en "error rápido": mejor, pero sigue siendo un error.
4. **Un breaker global para todo el servicio.** Si no es por dependencia (o
   por host), un endpoint lento te corta todo.

Un quinto que suma: **no contar la latencia**. Si tu breaker sólo mira
errores, un servicio que responde 200 en 30 segundos nunca lo abre — y ése es
justo el caso de A1.

### A6 — Bulkhead vs circuit breaker

> **El bulkhead evita que el daño se propague (preventivo, estructural).
> El breaker acorta la duración del daño (reactivo, temporal).**

| | Bulkhead | Circuit breaker |
| --- | --- | --- |
| Cómo actúa | Reparte los recursos de antemano | Detecta fallos y corta |
| Cuándo | **Desde el primer milisegundo** | Después de juntar evidencia |
| Qué necesita saber | **Nada** | Qué está fallando y cuánto |

**No son alternativas**, y la simulación lo muestra con números:

```
sin protección               /checkout:  25,8 %
circuit breaker              /checkout:  78,9 %   <- no llega a 100%
bulkhead                     /checkout:  100 %    <- y sin detectar nada
breaker + bulkhead           /checkout:  100 %  +  /home sirve fallbacks
```

**Por qué el breaker solo no llega al 100%:** es reactivo. Entre que la
dependencia se degrada y que junta evidencia suficiente para abrirse, **el
pool ya se saturó**. Y cada paso a HALF-OPEN deja entrar sondas que vuelven a
ocupar conexiones por 5 segundos.

**Por qué el bulkhead solo no alcanza tampoco:** `/home` queda esperando
timeouts de 5 s indefinidamente, quemando su propio presupuesto y dándole al
usuario una página lenta. El breaker es lo que lo convierte en un fallback
instantáneo.

### A7 — Fallo metaestable

> Un sistema está en estado metaestable cuando **sigue en el estado malo
> aunque la causa original haya desaparecido**, porque algo del propio sistema
> lo sostiene.

El lazo de este módulo:

```
pico -> la cola crece -> las requests superan el timeout -> el cliente SE VA
     -> el cliente reintenta (carga nueva)
     -> y el servidor sigue procesando el trabajo VIEJO que ya no sirve
     -> menos capacidad útil -> más vencimientos -> más reintentos
```

La pieza que casi nadie modela, y que la simulación muestra: **el servidor no
sabe que el cliente se fue**. Sigue procesando a pleno —1.000 req/s, 100% de
CPU— y el trabajo **útil** es **cero**. Sin retry budget, en la simulación
sigue así minutos después de que el pico terminó, con la cola en 5,4 millones.

**Tres ejemplos de módulos anteriores:**

1. **Módulo 04, B3** — se cae Redis y vuelve **vacío**: no hay caché porque la
   base está saturada, y la base está saturada porque no hay caché.
2. **Módulo 07, C3** — el loop de rebalances: el batch tarda más que
   `max.poll.interval.ms`, lo expulsan, otro reprocesa lo mismo, tarda lo
   mismo. **Progreso real: cero.**
3. **Módulo 01, sección 5** — la cola cuando la utilización pasa de 1: no se
   estabiliza en un valor alto, crece para siempre.

Lo que los caracteriza a los tres: **requieren intervención manual**. El
sistema no sale solo (D1).

> **Rúbrica bloque A**
> - **Mid:** sabe qué es un timeout y un circuit breaker.
> - **Senior:** explica por qué degradado es peor que caído con Little, elige
>   timeouts por p99, y entiende el mecanismo del jitter.
> - **Staff:** usa retry budget, distingue preventivo de reactivo, y nombra el
>   trabajo zombi como la pieza que sostiene el fallo metaestable.

---

## Bloque B — Números

### B1 — La cascada

- **(a)** `3 × 3 × 3 = **27 llamadas** a D por cada request de usuario.`
- **(b)** `500 × 27 = **13.500 req/s**` contra un servicio que está caído. No
  se va a poder recuperar: cada intento de volver recibe 27 veces la carga
  original.
- **(c) Dos formas, sin sacar los reintentos:**
  1. **Reintentar en una sola capa.** Elegís cuál —normalmente la más cercana
     a la dependencia, o el borde— y las demás **propagan** el error. La
     amplificación baja de 27x a 3x. Es una decisión de arquitectura que hay
     que escribir en algún lado, porque por defecto cada equipo agrega sus
     reintentos "por las dudas".
  2. **Retry budget** en cada capa. Aunque las tres reintenten, ninguna puede
     superar el 10% extra, así que la amplificación máxima es
     `1,1³ ≈ 1,33x` en vez de 27x. **Y se apaga sola cuando todo falla**,
     que es justo cuando hace falta.

### B2 — Timeout 3 s × 3 reintentos

- **(a)** `4 intentos × 3 s de timeout + (1 + 2 + 4) s de espera = **19
  segundos**` en el peor caso.
- **(b)** Tu SLO es 2 s y tu configuración puede tardar **19**. Son 9,5x el
  objetivo. Peor: a los 2 segundos **el usuario ya se fue** (cerró, recargó o
  reintentó), así que los 17 segundos restantes son **trabajo para nadie** —
  exactamente el trabajo zombi que produce el fallo metaestable de A7.
- **(c) Cómo se corrige: el presupuesto total manda sobre los intentos
  individuales.**

  ```
  presupuesto total = 2 s  (el SLO)
    intento 1: timeout 700 ms
    espera: random(0, 300 ms)        <- jitter
    intento 2: timeout 700 ms
    -> peor caso: 1,7 s. Entra en el presupuesto.
  ```

  Y lo que hay que hacer además: **propagar un deadline absoluto** (módulo 02,
  A4). Antes de cada intento, chequear *"¿me queda presupuesto?"*; si no,
  fallar ya. Así nunca empezás un trabajo que no vas a poder entregar a
  tiempo.

  Si con 1,7 s el éxito no alcanza, el problema no es la configuración de
  reintentos: es que la dependencia no cumple con lo que tu SLO necesita, y
  hay que sacarla del camino crítico (módulo 02).

### B3 — 50.000 clientes sincronizados

- **(a)** En el segundo 1, los 50.000 reintentan **a la vez**: la simulación
  mide **495.000 req/s contra una capacidad de 5.000 — 99x**. Se atienden 5.000
  y 45.000 rebotan. Al segundo 2 vuelven a rebotar juntos, y así.
- **(b) Por qué el jitter drena con menos trabajo total** — es
  contraintuitivo y vale la pena decirlo bien:

  Sin jitter, **cada oleada se estrella entera** contra la capacidad. Se
  atiende la misma fracción chica y **el resto rebota completo**, oleada tras
  oleada, hasta agotar sus intentos. Resultado: **567.000 intentos totales y
  el 88% de los clientes se rinde sin ser atendido**.

  Con jitter, los clientes llegan **repartidos en el tiempo**, así que en cada
  instante hay lugar para los que llegan, y cada uno sale a la primera o la
  segunda. Resultado: **208.000 intentos (2,7x menos) y 0% de clientes que se
  rinden**.

  > **Esperar un rato al azar hace que todos terminen antes.** No es una
  > paradoja: el trabajo desperdiciado en reintentos fallidos es tan grande
  > que eliminarlo compensa con creces la espera.
- **(c) Un backoff sin techo es un bug** porque `2^12 × 500 ms = 34 minutos`.
  El cliente ya se fue hace media hora; cuando por fin reintente, va a ser un
  pico sorpresa sobre un sistema que ya se había estabilizado. **Siempre
  `min(TECHO, ...)`**, con el techo en el orden de decenas de segundos.

### B4 — El pool compartido

- **(a)** `L = λ × W = 100 req/s × 5 s = **500 conexiones**`. El pool tiene
  **50**. Falta un orden de magnitud.
- **(b) `/checkout` se cae también**, al 26% de éxito en la simulación, con
  p99 de 5 segundos — y **no usa esa dependencia en absoluto**. Se queda
  esperando una conexión del pool compartido que `/home` tiene toda tomada.
  **El fallo no se propagó por la dependencia: se propagó por el pool.** Es el
  mismo mecanismo del módulo 01 (C2) y del módulo 02 (B5).
- **(c) El bulkhead lo habría evitado por completo**: `/checkout` queda en
  **100% de éxito y p99 de 30 ms**, como si no hubiera pasado nada — porque
  para él no pasó nada.

  Y la razón por la que es tan efectivo: **no necesita detectar nada**. No
  cuenta fallos, no decide, no tiene umbral que calibrar ni ventana que
  afinar. Reparte los recursos de antemano y listo. Es protección
  **estructural**, y por eso funciona desde el primer milisegundo — mientras
  que el breaker recién actúa cuando el daño ya empezó.

> **Rúbrica bloque B**
> - **Mid:** calcula la amplificación y sabe que hay que poner timeouts.
> - **Senior:** deriva el presupuesto total de latencia del SLO, explica el
>   jitter con el dato de los intentos totales, y usa Little para el pool.
> - **Staff:** propaga deadline absoluto entre intentos, y ve que el bulkhead
>   gana por no necesitar detección.

---

## Bloque C — Aplicado

### C1 — Los tres (en realidad cinco) problemas

```ts
async function cobrar(orden: Orden) {
  for (let i = 0; i < 5; i++) {
    try {
      return await this.http.post('https://pagos.externo.com/charge', orden);
    } catch (e) { await sleep(1000); }
  }
  throw new Error('No se pudo cobrar');
}
```

**1. No hay timeout.** El default de la mayoría de los clientes HTTP es
infinito o absurdamente largo. Si el proveedor se cuelga, este `await` **no
vuelve nunca**: la conexión queda tomada, y con 100 req/s tenés el pool
agotado en segundos (módulo 02, B5).

**2. Backoff fijo sin jitter.** `sleep(1000)` constante: no es exponencial —
así que si la dependencia necesita 30 s para recuperarse, le pegás 5 veces en
5 segundos y te rendís— y **no tiene jitter**, así que todos los clientes que
fallaron juntos vuelven juntos (A3).

**3. Reintenta un COBRO sin clave de idempotencia.** Es el más grave:
**5 intentos pueden ser 5 cobros**. Si el primero salió bien y la respuesta se
perdió, los 4 reintentos cobran de nuevo (módulo 06). Reintentar sólo es
seguro si la operación es idempotente, y un `POST /charge` no lo es por sí
solo.

**4. Reintenta TODOS los errores.** Un `400` por un campo mal formado se
reintenta 5 veces y falla 5 veces. Gasta y no arregla nada (sección 3).

**5. Pierde la causa.** El `catch (e)` descarta el error y al final lanza un
`Error` genérico: nadie va a saber nunca si fue un timeout, un 400 o un 503.
Y sin retry budget, con todos los pods haciendo esto, amplificás ×5 justo
cuando el proveedor está sufriendo.

**La versión corregida:**

```ts
async function cobrar(orden: Orden) {
  const BASE = 300, TECHO = 5_000, INTENTOS = 3;
  const deadline = Date.now() + 8_000;            // presupuesto TOTAL
  let ultimo: unknown;

  for (let i = 0; i < INTENTOS; i++) {
    if (Date.now() >= deadline) break;            // no empieces lo que no llega
    if (!this.breaker.permite()) break;           // fail fast si está abierto

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(3_000, deadline - Date.now()));
      try {
        const res = await this.http.post(URL, orden, {
          signal: ctrl.signal,                                  // 1: timeout real
          headers: { 'Idempotency-Key': `orden-${orden.id}-cobro` },  // 3: determinística
        });
        this.breaker.exito();
        return res;
      } finally { clearTimeout(timer); }
    } catch (e) {
      ultimo = e;
      if (!esReintentable(e)) throw e;            // 4: no reintentar 4xx
      this.breaker.fallo();
      if (!this.retryBudget.consumir()) break;    // 5: presupuesto global
      await sleep(Math.random() * Math.min(TECHO, BASE * 2 ** i));   // 2: full jitter
    }
  }
  throw new PagoFallidoError('No se pudo cobrar', { cause: ultimo });   // 5: conservar la causa
}
```

El `AbortController` no es decorativo: sin él, el `await` vence pero **la
request sigue en vuelo** ocupando un socket. Es el error más sutil de la lista.

### C2 — El proveedor del LLM devuelve `429`

**(a) Sin nada especial**, tu cliente HTTP lanza una excepción y —si tenés un
interceptor de reintentos genérico— **reintenta inmediatamente**. Vas a
empeorar la situación sin darte cuenta, porque un `429` es la dependencia
diciéndote explícitamente *"estás mandando de más"*.

**(b) Por qué reintentar inmediatamente es peor que no reintentar:** el `429`
no es un fallo transitorio aleatorio: es una **medida de control**. Cada
reintento inmediato consume más cuota, extiende la ventana de penalización, y
—con varios proveedores— **empeora el backoff que te imponen**. Con 20 pods
haciendo lo mismo, pasás de estar un poco por encima de la cuota a estar
masivamente por encima. Es el retry storm de A4, autoinfligido.

**(c) El manejo correcto:**

1. **Respetar `Retry-After`.** El header te dice exactamente cuánto esperar
   (en segundos o como fecha HTTP). **Es información que el proveedor te está
   regalando** y casi nadie la lee. Si no viene, full jitter con techo.
2. **Un limitador de concurrencia global** (semáforo en Redis), dimensionado
   con tu cuota real. La cuota se comparte entre **todos** tus pods, así que
   un limitador por pod no sirve: `cuota / n_pods` se desbalancea en cuanto el
   tráfico no cae parejo.
3. **Backpressure, no acumulación en memoria**: si no hay cuota, que el
   trabajo espere en la cola (módulo 07), donde es visible y medible, no en la
   memoria de tus pods.
4. **No reintentar indefinidamente**: presupuesto y DLQ.

**(d) El rol del breaker acá, que es distinto al de una base de datos:** con
Postgres, un intento fallido cuesta **latencia y una conexión**. Con un LLM,
**cada intento puede costar dinero** — algunos proveedores facturan tokens de
entrada aunque la respuesta falle o se corte. El breaker no está protegiendo
tu pool: **está protegiendo tu factura**.

Y hay un segundo rol: la cuota es **compartida entre todo tu sistema**. Un
breaker abierto le libera cuota a los demás consumidores que sí pueden
avanzar. Con una base, el recurso saturado es tuyo; con un proveedor externo,
lo estás compartiendo con vos mismo.

### C3 — Se cae Redis (módulo 04, B3)

**(a)** Los 80.000 req/s van íntegros a una base que aguanta 6.000: **13x su
capacidad**. El pool se agota en menos de un segundo, las requests se encolan,
la concurrencia en vuelo explota por Little, los timeouts disparan y **los
clientes reintentan**, sumando carga a un sistema que ya no da abasto.

**(b) No se recupera solo** por tres razones: Redis vuelve **vacío**, así que
el hit rate arranca en 0%; repoblarlo requiere que las queries terminen y la
base está saturada; y la carga ahora incluye **los reintentos acumulados**. Es
un fallo metaestable (A7).

**(c) Las defensas, por relación beneficio/esfuerzo:**

1. **Caché local en los pods con TTL de 5-10 s.** Lo más barato y lo que más
   compra: una clave con 3.000 req/s pasa a 0,2 req/s por pod. **Convierte el
   13x en algo que la base tolera**, y funciona con Redis completamente caído.
2. **Single-flight local** (`Map<string, Promise>`): con hit rate 0, que haya
   **una** query en vuelo por clave distinta por pod en vez de miles. Son 5
   líneas.
3. **Circuit breaker delante de la base** + **load shedding con prioridades**:
   servir error en 5 ms al 70% del tráfico es infinitamente mejor que morir
   para el 100%, y deja aire para el 30% que sí importa.
4. **Saber el número de antemano**: cuántas req/s aguanta la base sin caché,
   medido en una prueba de carga. Si es menor que tu tráfico, Redis **no es
   una optimización: es una dependencia crítica** y merece el tratamiento de
   una (réplicas, failover probado, alertas).

### C4 — `livenessProbe` que chequea Postgres

**(a) La secuencia:**

```
1. La base tiene un hipo de 30 s (failover, VACUUM pesado, pico de conexiones)
2. El liveness falla EN TODOS LOS PODS A LA VEZ: todos dependen de la misma base
3. Kubernetes reinicia LA FLOTA ENTERA, simultáneamente
4. Cero pods sirviendo tráfico: degradación parcial -> CAÍDA TOTAL
5. Al arrancar todos juntos, abren todas sus conexiones de golpe contra una
   base que ya estaba sufriendo -> la terminan de matar
6. El liveness vuelve a fallar -> reinicio -> CrashLoopBackOff en cascada
7. El sistema NO sale solo, aunque la base se recupere
```

**(b) Por qué convierte una degradación en una caída total:** porque el
liveness está diseñado para detectar **un proceso roto**, que es un fallo
**independiente** por pod. Al atarlo a una dependencia **compartida**,
convertís un fallo correlacionado en un reinicio correlacionado — y le sumás
el *thundering herd* del arranque simultáneo contra el recurso que ya estaba
mal. Es un fallo metaestable disparado por tres líneas de YAML.

**(c) La regla:**

> **Liveness chequea sólo el proceso** (`return 'ok'` está perfecto): "¿este
> proceso está trabado y hay que reiniciarlo?".
> **Readiness chequea las dependencias**: "¿puede atender tráfico ahora?".

La diferencia operativa es todo: readiness lo **saca del balanceador sin
reiniciarlo**, así que cuando la base vuelve, el pod vuelve solo, con sus
pools y su caché calientes. Liveness lo **mata**.

> **Rúbrica bloque C**
> - **Mid:** ve que falta el timeout y que el backoff es fijo.
> - **Senior:** ve que reintentar un cobro sin clave de idempotencia es el bug
>   grave, respeta `Retry-After`, y conoce la regla liveness/readiness.
> - **Staff:** usa `AbortController` (el `await` vence, la request no),
>   presupuesto total con deadline, y ve que con un LLM el breaker protege la factura.

---

## Bloque D — Diseño abierto

### D1 — Sigue devolviendo 500 media hora después

**Qué está pasando: un fallo metaestable.** El pico pasó, el tráfico de
usuarios está normal, y el sistema sigue saturado porque **la carga ahora son
sus propios reintentos y el trabajo zombi acumulado en sus colas**.

**Por qué no sale solo:** porque el lazo de realimentación se sostiene sin la
causa original. El servidor está al 100% procesando requests cuyo cliente se
fue hace rato; cada una que vence genera un reintento nuevo; la cola nunca
baja. En la simulación, el trabajo **útil** es **cero** mientras el servidor
procesa 1.000 req/s a pleno.

**A las 3 AM, el orden exacto — y el principio es: primero bajar la
utilización por debajo de 1, después investigar.**

```
1. CORTAR LA ENTRADA. Load shedding agresivo en el borde: rechazar un
   % del tráfico con 503 rápido, o rate limiting duro. Objetivo: que
   la carga ofrecida baje de la capacidad. Es lo único que rompe el
   lazo, y es lo que más cuesta hacer porque se siente como rendirse.

2. APAGAR LOS REINTENTOS. Feature flag, retry budget a 0, o la
   configuración del mesh. Si no podés, el paso 1 tiene que ser más
   agresivo todavía.

3. VACIAR LAS COLAS DE TRABAJO ZOMBI. Purgar la cola interna o
   reiniciar los workers con cola limpia. Si no, seguís masticando
   trabajo que no le sirve a nadie. ESTE ES EL PASO QUE CASI NADIE
   HACE y es el que libera la capacidad útil.

4. RECUPERAR EL ESTADO que el fallo destruyó: precalentar el caché si
   el problema fue ése, reiniciar consumers en orden.

5. DEVOLVER EL TRÁFICO GRADUALMENTE: 10%, 25%, 50%, 100%, mirando
   latencia y errores en cada escalón. Abrir todo de golpe REPRODUCE
   el colapso — y es el error clásico de la recuperación.

6. RECIÉN AHORA investigar la causa original.
```

**Qué cambiar después:**

1. **Retry budget** en todos los clientes. Es la defensa que ataca el lazo.
2. **Colas acotadas**: rechazar rápido en vez de encolar infinito.
3. **Descartar trabajo vencido en el servidor.** Antes de procesar, chequear
   *"¿el deadline de esta request ya pasó?"* y tirarla. **Es la defensa más
   directa contra el trabajo zombi** y la que elimina el lazo de raíz. Se
   apoya en propagar un deadline absoluto (módulo 02, A4).
4. **Load shedding con prioridades**, configurado y **probado**, no
   improvisado a las 3 AM.
5. **Un runbook con estos pasos**, porque el que esté de guardia la próxima no
   va a ser el mismo.

### D2 — Estrategia completa de `POST /orders`

**Primero el presupuesto total**, porque todo lo demás se deriva de ahí:
**p99 de 1,5 s** para la respuesta al usuario.

**Y la primera decisión, que define el diseño:**

> **Pagos tiene p99 de 4 s. No entra en un presupuesto de 1,5 s. Punto.**
> No es un problema de timeouts: es que **no puede ser síncrono**.

Sumale su SLA de 99,5%, que pondría tu techo de disponibilidad en
`0,999 × 0,995 = 99,4%` (4,3 horas de caída al mes dominadas por un tercero).
Así que el diseño es el del módulo 02, C1(c): **202 + confirmación por
evento**.

```
POST /orders  (Idempotency-Key)
 ├─ stock      SÍNCRONO   timeout 100 ms   1 reintento    breaker: FAIL CLOSED
 ├─ cobertura  SÍNCRONO   timeout 150 ms   1 reintento    breaker: fallback permisivo
 ├─ persistir orden PENDING_PAYMENT + outbox   (una transacción)
 └─ 202 Accepted                                           ~250 ms p99
         │
         ▼  (asíncrono, por cola)
 ├─ pagos      timeout 8 s   backoff+jitter, Idempotency-Key = orden-{id}-cobro
 │             breaker: si está abierto, el mensaje espera en la cola
 └─ reserva de envío   (outbox -> evento)
```

| Dependencia | Timeout | Criterio | Reintentos | Breaker / fallback |
| --- | --- | --- | --- | --- |
| **Stock** (20 ms) | **100 ms** | p99 × ~2 con margen | 1, es una lectura idempotente | **Fail closed**: sin stock verificado no hay orden. No se puede degradar |
| **Cobertura de envío** (50 ms) | **150 ms** | p99 × ~2 | 1 | Fallback **permisivo**: aceptar y validar después. Es una validación, no una ejecución |
| **Pagos** (p99 4 s) | **8 s** | p99 × 2, y fuera del camino crítico | 3 con backoff + jitter **y clave de idempotencia** | Breaker abierto → el mensaje **queda en la cola**, no se pierde |

**Dónde reintento y dónde no:**

- **Stock y cobertura**: sí, 1 vez. Son lecturas idempotentes y baratas.
- **Pagos**: sí, **pero sólo porque hay `Idempotency-Key` determinística**.
  Sin ella, cero reintentos. Es la regla del módulo 06.
- **La escritura a mi propia base**: reintento sólo los deadlocks (`40P01`),
  que son transitorios por definición (módulo 05, C3).
- **Nunca reintento desde el borde Y desde el servicio**: elijo una capa. Con
  retry budget del 10% en cada una, la amplificación máxima queda en ~1,2x.

**Aislamiento de recursos:**

- **Pool de la base separado** para el camino crítico (`POST /orders`) y para
  los workers asíncronos. Un backfill no puede agotarle las conexiones al
  checkout (módulo 07, D1).
- **Agente HTTP y semáforo de concurrencia propios por dependencia externa**.
  Pagos no comparte presupuesto con nada.
- **Los workers de pagos son un deployment aparte**: si se saturan, `POST
  /orders` sigue respondiendo 202 en 250 ms.

**El reparto del presupuesto:**

```
stock             100 ms
cobertura         150 ms   (en paralelo con stock -> toma el máximo: 150 ms)
escritura + outbox 60 ms
overhead (auth, serialización, red)  ~40 ms
                  ───────
total p99         ~250 ms   contra un presupuesto de 1.500 ms
```

Sobra margen **a propósito**: ese colchón es lo que absorbe un pico sin que el
p99 se dispare (módulo 01, sección 5), y lo que permite agregar una
dependencia más adelante sin rediseñar.

**Y el número que justifica todo el diseño:** con todo síncrono el techo era
`0,999³ × 0,995 = 99,2%` (5,7 h/mes). Con pagos y envíos fuera del camino
crítico: `0,999² = 99,8%` (86 min/mes). **Sacar dos dependencias del camino
crítico vale más que cualquier optimización de timeouts.**

> **Rúbrica bloque D**
> - **Mid:** reconoce el retry storm y propone reiniciar.
> - **Senior:** ordena la recuperación (cortar, apagar reintentos, volver
>   gradual), y deriva los timeouts del presupuesto total.
> - **Staff:** vacía las colas de trabajo zombi, propone descartar requests con
>   deadline vencido, y justifica el diseño con el techo de disponibilidad.

---

## Fuentes para profundizar

- **AWS Builders' Library**, *Timeouts, retries and backoff with jitter*:
  <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **AWS**, *Exponential Backoff And Jitter* — con las mediciones que confirman
  B3(b): <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
- **Marc Brooker**, *Metastable Failures in Distributed Systems*:
  <https://brooker.co.za/blog/2021/05/24/metastable.html>
- **Bronson et al.**, *Metastable Failures in Distributed Systems* (HotOS 2021):
  <https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf>
- **Michael Nygard**, *Release It!* — circuit breaker y bulkhead, con los
  post-mortems que los originaron.
- **Google SRE Book**, *Handling Overload* y *Addressing Cascading Failures*:
  <https://sre.google/sre-book/handling-overload/>
- **gRPC**, *Retry design* (retry budgets, throttling):
  <https://github.com/grpc/proposal/blob/master/A6-client-retries.md>

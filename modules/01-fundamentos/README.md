# Módulo 01 — Fundamentos: latencia, throughput, capacidad y SLOs

## Por qué empezar acá

En una entrevista de system design, la diferencia entre un candidato senior
y uno que suena senior aparece en los primeros 10 minutos: el que suena
senior dice "usaría una cola para desacoplar"; el senior de verdad dice
"son 5.000 escrituras por segundo, 400 bytes cada una, o sea 2 MB/s y
170 GB/día — eso no entra en una sola instancia de Postgres con este patrón
de escritura, así que...".

Todo lo que viene después (caching, sharding, Kafka, colas) son **respuestas
a un número**. Sin el número, la respuesta es cargo cult. Este módulo es la
caja de herramientas numérica que vamos a usar en los 14 módulos restantes.

## Teoría mínima

### 1. Los tres ejes de cualquier sistema

| Eje | Qué mide | Unidad típica | Se rompe cuando... |
| --- | --- | --- | --- |
| **Latencia** | Cuánto tarda **una** operación | ms | Un usuario espera de más |
| **Throughput** | Cuántas operaciones por unidad de tiempo | req/s, msg/s, MB/s | La cola crece sin parar |
| **Disponibilidad** | Qué fracción del tiempo el sistema responde bien | % (nueves) | Se cae y no hay degradación elegante |

Y son **antagónicos entre sí**. Batchear mejora el throughput y empeora la
latencia. Replicar mejora la disponibilidad y empeora la consistencia y el
costo. **Todo diseño es elegir qué eje sacrificar.** Cuando en una entrevista
te preguntan "¿y esto no lo podrías hacer más rápido?", casi siempre la
respuesta correcta es "sí, a cambio de X".

### 2. Números que hay que saber de memoria

Órdenes de magnitud (no hace falta el número exacto, hace falta la escala):

```
Referencia a memoria (L1/RAM)          ~ 0,0001 ms   (100 ns)
Compresión de 1 KB                     ~ 0,003 ms
Lectura secuencial de 1 MB desde RAM   ~ 0,05  ms
SSD NVMe: lectura random 4 KB          ~ 0,1   ms
Lectura secuencial de 1 MB desde SSD   ~ 0,5   ms
Round-trip dentro del mismo datacenter ~ 0,5   ms
Query simple a Postgres (índice, local)~ 1     ms
GET a Redis (misma AZ)                 ~ 1     ms
Round-trip entre AZs (misma región)    ~ 1-2   ms
Disco rotacional: seek                 ~ 10    ms
Round-trip US-East ↔ Europa            ~ 80    ms
Round-trip US-East ↔ Sudamérica        ~ 120   ms
Round-trip intercontinental (ida+vuelta especialmente malo) ~ 150-250 ms
Llamada a un LLM (primer token)        ~ 300-2000 ms
Llamada a un LLM (respuesta completa)  ~ 2-60  s
```

Tres consecuencias directas que se usan todo el tiempo:

- **La red domina.** Un `SELECT` de 1 ms al que le agregás 3 saltos de red
  entre servicios ya es 5-7 ms. En una arquitectura de microservicios, la
  mayor parte de la latencia es *red y serialización*, no *cómputo*.
- **La geografía es física.** La luz en fibra hace ~200 km/ms. Buenos Aires
  ↔ Virginia son ~8.000 km, o sea ~40 ms de ida en el mejor caso teórico y
  ~120 ms de round-trip en la práctica. **Ningún caché arregla eso**: la
  única solución es acercar el cómputo al usuario (edge, multi-región).
- **El LLM es de otro planeta.** Un agente de IA que llama a un modelo tiene
  una operación que es 1.000-10.000x más lenta que todo lo demás del sistema.
  Eso cambia por completo el diseño: no podés tratarla como una llamada HTTP
  normal (módulo 14).

### 3. Percentiles: por qué el promedio miente

Nunca mires el promedio de latencia. Mirá `p50`, `p95`, `p99`, `p99.9`.

- `p99 = 800 ms` significa: 1 de cada 100 requests tarda **800 ms o más**.
- Si tu API recibe 10.000 req/s, ese "1%" son **100 requests por segundo**
  sufriendo. Es decir, 8,6 millones de requests malos por día.
- El promedio esconde esto por completo: una distribución con p50 de 20 ms
  y p99 de 2 s puede tener un promedio perfectamente inocente de 45 ms.

**Amplificación de cola (tail latency amplification)** — el concepto más
importante de esta sección y el que más se pregunta:

> Si una request del usuario necesita llamar a **N** servicios en paralelo y
> esperar a todos, la latencia percibida es la del **más lento** de los N.

Con cada servicio teniendo un p99 de 100 ms:

| N servicios en paralelo | Probabilidad de que **ninguno** sea lento | Latencia del usuario |
| --- | --- | --- |
| 1 | 99% | p99 de uno |
| 10 | 0,99¹⁰ = 90,4% | ~1 de cada 10 usuarios pega el p99 |
| 100 | 0,99¹⁰⁰ = 36,6% | **63% de los usuarios pega el p99** |

Con 100 dependencias, **el p99 de tus servicios se convierte en el p63 del
usuario**. Por eso los sistemas grandes usan *hedged requests* (mandar la
misma request a dos réplicas y quedarse con la primera respuesta) y
*timeouts agresivos con degradación* en vez de perseguir un p99 perfecto.

Lo vas a ver con tus propios ojos corriendo `percentiles.ts`.

### 4. Ley de Little: el puente entre latencia y throughput

```
L = λ × W
```

- `L` = cantidad promedio de requests **dentro del sistema** (concurrencia)
- `λ` = tasa de llegada (throughput, req/s)
- `W` = tiempo promedio dentro del sistema (latencia, s)

Es una identidad, no una aproximación: vale siempre, para cualquier sistema
estable. Y es una calculadora mental brutal:

- **¿Cuántos workers necesito?** Si llegan 500 req/s y cada una tarda 200 ms:
  `L = 500 × 0,2 = 100` requests concurrentes. Si cada worker maneja una a la
  vez, necesitás **100 workers**. Si tenés 20, la cola crece para siempre.
- **¿Cuánto pool de conexiones a la DB?** Si hacés 1.000 queries/s de 5 ms:
  `1000 × 0,005 = 5` conexiones activas en promedio. Poner un pool de 200
  no acelera nada — sólo mata a Postgres con context switching.
- **Al revés:** si tenés un pool de 10 conexiones y cada query tarda 20 ms,
  tu techo teórico es `10 / 0,02 = 500 queries/s`. Punto. Ningún autoscaling
  de la app rompe ese techo.

### 5. Utilización: por qué el sistema explota antes de llegar al 100%

Ésta es la que separa a los que leyeron un blog de los que operaron sistemas.
En una cola con llegadas aleatorias (M/M/1), el tiempo de espera es:

```
W = S / (1 - ρ)        donde ρ = utilización (0 a 1), S = tiempo de servicio
```

| Utilización | Multiplicador de latencia |
| --- | --- |
| 50% | 2x |
| 70% | 3,3x |
| 80% | 5x |
| 90% | **10x** |
| 95% | **20x** |
| 99% | **100x** |

La latencia **no crece linealmente con la carga: crece asintóticamente**. Un
servicio al 90% de CPU no está "bien aprovechado", está a un pico de tráfico
de tener latencia 10x. Por eso la regla operativa real es **no pasar del
60-70% de utilización sostenida** — ese 30-40% "desperdiciado" es lo que se
come los picos sin que se dispare el p99.

Corolario para entrevistas: cuando te preguntan "¿por qué se degradó todo si
la CPU estaba en 85% y no en 100%?", la respuesta es esto.

Lo vas a ver corriendo `cola-mm1.ts`.

### 6. Back-of-the-envelope: el ritual de los primeros 5 minutos

Siempre el mismo orden:

1. **Usuarios y actividad** → DAU, acciones por usuario por día.
2. **QPS promedio** → `acciones_por_día / 86.400`.
3. **QPS pico** → promedio × 2 a 10 (según si el tráfico es humano y con
   horarios, o distribuido globalmente). Para tráfico humano regional, ×5 es
   una regla defendible.
4. **Lectura vs escritura** → la relación (100:1 en una red social, 1:1 en
   un sistema de pagos) define toda la estrategia de caching y réplicas.
5. **Storage** → `escrituras/día × bytes × días de retención`, y por
   separado el crecimiento anual.
6. **Ancho de banda** → `QPS × tamaño_payload`.
7. **Memoria de caché** → regla 80/20: el 20% de los datos recibe el 80% de
   las lecturas; dimensioná el caché para ese 20% "caliente".

Constantes útiles: **86.400 s/día ≈ 100.000** (redondear para arriba está
bien y hace las cuentas mentales triviales). 1 millón de segundos ≈ 11,5 días.
2^10 ≈ mil, 2^20 ≈ millón, 2^30 ≈ mil millones.

`back-of-the-envelope.ts` hace exactamente este ritual sobre un caso de tu
stack, para que puedas cambiar los inputs y ver qué se rompe.

### 7. SLI, SLO, SLA y error budget

- **SLI** (*Indicator*): la métrica. "Porcentaje de requests con latencia
  < 300 ms" o "porcentaje de requests sin 5xx".
- **SLO** (*Objective*): el objetivo interno sobre ese SLI. "99,9% de las
  requests responden < 300 ms, medido en ventanas de 30 días".
- **SLA** (*Agreement*): el contrato con el cliente, con plata de por medio.
  **Siempre más laxo que el SLO** — el SLO es tu alarma temprana; el SLA es
  la línea donde pagás.

**Error budget** = `1 - SLO`. Con un SLO de 99,9% mensual tenés **43 minutos
de presupuesto de error por mes**. Ese presupuesto es un recurso que se
gasta: si en la primera semana ya quemaste 40 minutos, se congelan los
deploys riesgosos. Si a fin de mes te sobró todo el presupuesto, tu SLO es
demasiado laxo o estás siendo demasiado conservador para innovar.

Los nueves, para tener la escala en la cabeza:

| Disponibilidad | Downtime / año | Downtime / mes |
| --- | --- | --- |
| 99% ("dos nueves") | 3,65 días | 7,3 horas |
| 99,9% | 8,8 horas | 43 min |
| 99,95% | 4,4 horas | 22 min |
| 99,99% | 52 min | 4,4 min |
| 99,999% | 5,3 min | 26 s |

Dato clave para entrevistas: **cada nueve extra cuesta aproximadamente 10x**
y el salto de 99,9% a 99,99% suele exigir multi-AZ activo, failover
automatizado y despliegues sin downtime. Nunca prometas cuatro nueves sin
que te pregunten cuánto vale.

**La trampa de la disponibilidad compuesta:** si tu servicio depende
sincrónicamente de 5 servicios de 99,9% cada uno, tu disponibilidad máxima
teórica es `0,999⁵ = 99,5%` — o sea 3,6 horas de downtime al mes, aunque tu
código sea perfecto. Esto es el argumento numérico más fuerte a favor de la
comunicación asíncrona, y es de lo que trata el módulo 02.

### 8. Aplicado a tu stack (NestJS / Node)

Node corre tu código en **un solo hilo** (el event loop). Consecuencias que
hay que tener presentes en todo el resto del path:

- **I/O no bloquea, CPU sí.** 10.000 conexiones esperando I/O están bien.
  Un `JSON.parse` de 20 MB, un `bcrypt`, o un loop de 500 ms bloquean *todas*
  las requests del proceso. En la Ley de Little, ese trabajo de CPU es `W`
  para todos los demás simultáneamente.
- **Tu concurrencia útil por pod está limitada por el pool de conexiones**
  a la DB, no por Node. Aplicá Little al pool antes de escalar pods.
- **El p99 de Node suele delatar GC y event-loop lag**, no queries lentas.
  Medir `event loop delay` (`perf_hooks.monitorEventLoopDelay`) es tan
  importante como medir latencia de endpoint.
- Escalás **horizontalmente por proceso**: N pods × 1 hilo útil. Por eso el
  autoscaling en ECS/EKS por CPU funciona razonablemente, pero recordá el
  punto 5: escalá apuntando a ~60-70%, no a 90%.

## Lo que vas a correr

Sin dependencias. Node >= 22.18:

```bash
node modules/01-fundamentos/percentiles.ts
node modules/01-fundamentos/cola-mm1.ts
node modules/01-fundamentos/back-of-the-envelope.ts
```

1. **`percentiles.ts`** — genera una distribución realista de latencias
   (mayoría rápida + cola larga), muestra por qué el promedio miente, y
   simula la amplificación de cola con fan-out a N servicios.
2. **`cola-mm1.ts`** — simula una cola con llegadas aleatorias y te muestra
   la latencia real a distintos niveles de utilización. Ver el salto entre
   70% y 95% en tu propia terminal es la parte que se te queda grabada.
3. **`back-of-the-envelope.ts`** — el ritual de la sección 6 sobre un caso
   concreto (una API de agentes de IA con Kafka y Postgres). Cambiá los
   inputs de arriba del archivo y mirá qué decisión de arquitectura cambia.

## Para pensar / próximo paso

- Tu API NestJS tiene p50 de 40 ms y p99 de 1,2 s. ¿Cuáles son las **tres**
  causas más probables, en orden, antes de mirar una sola línea de código?
- Un endpoint hace 4 llamadas gRPC en paralelo a servicios con p99 de 200 ms.
  ¿Cuál es el p99 aproximado del endpoint? ¿Y si fueran secuenciales?
- Si el SLO es 99,9% y tu servicio depende sincrónicamente de un proveedor
  externo con SLA de 99,5%, **¿podés cumplir tu SLO?** ¿Qué tenés que cambiar
  en el diseño para que la respuesta sea sí?

Estas tres son, casi textuales, preguntas de entrevista. Están respondidas en
`respuestas.md` — pero primero hacé el `quiz.md`.

## Fuentes

- Jeff Dean, *Latency Numbers Every Programmer Should Know* — la tabla
  original: <https://colin-scott.github.io/personal_website/research/interactive_latency.html>
- Dean & Barroso, *The Tail at Scale*, CACM 2013 — el paper de la
  amplificación de cola: <https://research.google/pubs/the-tail-at-scale/>
- Google SRE Book, caps. *Service Level Objectives* y *Managing Risk*:
  <https://sre.google/sre-book/service-level-objectives/>
- Gil Tene, *How NOT to Measure Latency* (charla) — por qué casi todas las
  herramientas miden mal los percentiles: <https://www.youtube.com/watch?v=lJ8ydIuPFeU>
- Neil Gunther, *Universal Scalability Law* — la versión formal de la
  sección 5: <http://www.perfdynamics.com/Manifesto/USLscalability.html>

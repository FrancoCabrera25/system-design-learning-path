# Caso 05 — El checkout que se cayó por las recomendaciones

> **Módulos:** [08 (fiabilidad)](../modules/08-fiabilidad/) ·
> [01 (fundamentos)](../modules/01-fundamentos/)
> **Patrones:** Bulkhead + Circuit breaker + degradación

---

## 1. El escenario

Un e-commerce en NestJS. Dos endpoints que comparten el mismo proceso y el
mismo pool de conexiones:

```
/checkout   100 req/s   -> consulta stock y precios en Postgres (30 ms)
/home       100 req/s   -> consulta "recomendaciones" (servicio interno, 50 ms)

pool de conexiones: 50, COMPARTIDO
timeout hacia recomendaciones: 5 s
```

Recomendaciones **no es crítico**: si falla, se muestran productos genéricos y
nadie se entera. Nadie lo considera una dependencia importante. No está en el
diagrama de arquitectura con línea gruesa.

Un martes a las 15:40, el servicio de recomendaciones hace un deploy con una
query sin índice. Su latencia pasa de **50 ms a 30 segundos**.

## 2. Qué se rompe

**El síntoma:** el **checkout** empieza a devolver 500. La tasa de conversión
se cae. El equipo de pagos es despertado.

Y el diagnóstico tarda una hora porque **todo lo que miran está bien**:

- Postgres: CPU al 20%, sin queries lentas, sin locks. **Sana.**
- El pod de checkout: memoria normal, CPU baja. **Sano.**
- El código de checkout: no cambió. **No hubo deploy.**
- Y lo decisivo: **`/checkout` no llama a recomendaciones.** No la importa, no
  la conoce, no aparece en su traza.

**La causa.** Ley de Little ([módulo 01, §4](../modules/01-fundamentos/README.md)):

```
L = λ × W = 100 req/s × 5 s (el timeout) = 500 conexiones necesarias
pool disponible:                            50
```

Cada request de `/home` **toma una conexión del pool y la retiene los 5
segundos completos** del timeout. `/home` se come las 50 y `/checkout` se
queda esperando una conexión que no llega nunca.

> **El fallo no se propagó por la dependencia: se propagó por el POOL.**

Los números de
[`circuit-breaker.ts`](../modules/08-fiabilidad/circuit-breaker.ts):

```
configuración                /checkout éxito   p99 checkout
sin protección                        25,8 %       5.040 ms   💀
```

**El 74% del checkout caído por un servicio que no usa.** Y la razón por la
que nadie lo vio venir: en el inventario de dependencias, recomendaciones
figura como "no crítico". Lo es, **funcionalmente**. Pero comparte un recurso
con el camino crítico, y eso lo vuelve crítico **operativamente**.

Es el mismo mecanismo del [módulo 01, C2](../modules/01-fundamentos/respuestas.md)
(el pool agotado) y del [módulo 02, B5](../modules/02-comunicacion-servicios/respuestas.md)
(gRPC sin deadline). **Tres apariciones del mismo fallo con tres disfraces.**

## 3. La solución probada

**Bulkhead** (mamparo), el patrón que Michael Nygard nombró en *Release It!*
a partir de post-mortems reales. El nombre viene de los compartimentos
estancos de un barco: **una vía de agua no hunde el casco entero**.

```
❌ ANTES                          ✅ DESPUÉS
┌──────────────────────┐          ┌───────────┬──────────┐
│   pool de 50         │          │ checkout  │  home    │
│ checkout + home      │          │    35     │   15     │
└──────────────────────┘          └───────────┴──────────┘
  home se come las 50               home sólo puede agotar SUS 15
```

Y **arriba** de eso, un **circuit breaker** con **degradación**, para que
`/home` tampoco quede esperando timeouts eternamente.

Los dos, y la diferencia importa:

> **El bulkhead evita que el daño se propague (preventivo, estructural).
> El breaker acorta la duración del daño (reactivo, temporal).**

Los números lo muestran:

```
configuración                /checkout éxito   p99 checkout   /home éxito
sin protección                        25,8 %       5.040 ms          25 %   💀
circuit breaker                       78,9 %       5.010 ms        74,5 %   ⚠️
bulkhead (pools separados)             100 %          30 ms          25 %   ✅
breaker + bulkhead                     100 %          30 ms        74,4 %   ✅
```

**El bulkhead solo deja el checkout en 100% sin detectar nada.** El breaker
solo llega al 79% porque, cuando junta evidencia suficiente para abrirse, el
pool ya se saturó.

## 4. La implementación

### 4.1 Lo primero: pools separados por criticidad

```ts
// ❌ ANTES: un DataSource para todo
TypeOrmModule.forRoot({ /* ... */ extra: { max: 50 } });

// ✅ DESPUÉS: pools separados, dimensionados con la Ley de Little
TypeOrmModule.forRoot({
  name: 'critico',          // checkout, pagos, auth
  extra: { max: 35, connectionTimeoutMillis: 2_000 },  // ← timeout de ADQUISICIÓN
});
TypeOrmModule.forRoot({
  name: 'secundario',       // home, recomendaciones, analytics
  extra: { max: 15, connectionTimeoutMillis: 500 },
});
```

**`connectionTimeoutMillis` es el timeout que casi nadie configura** y es el
que delata la saturación ([módulo 08, §2](../modules/08-fiabilidad/README.md)).
Sin él, una request espera **indefinidamente** por una conexión: tu query
tarda 30 ms y la request tarda 5 s porque estuvo 4,97 s en la cola del pool.

Y el dimensionamiento no es arbitrario:

```
checkout:  λ=100 req/s, W=30 ms   -> L = 100 × 0,03 = 3 conexiones activas
           con margen para picos y para el p99: 35
home:      lo que sobre. Si se satura, se degrada SOLO.
```

### 4.2 El límite de concurrencia por dependencia externa

El pool de la base no es el único recurso compartido. También lo son los
sockets, la memoria y el event loop.

```ts
@Injectable()
export class Bulkhead {
  private readonly limites = new Map<string, Semaforo>([
    ['pagos',           new Semaforo(50)],   // crítico: la mayor parte
    ['stock',           new Semaforo(30)],
    ['recomendaciones', new Semaforo(10)],   // si se satura, se degrada solo
    ['analytics',       new Semaforo(5)],
  ]);

  async ejecutar<T>(dependencia: string, fn: () => Promise<T>): Promise<T> {
    const sem = this.limites.get(dependencia)!;
    // RECHAZO INMEDIATO si no hay slot: no encolamos (módulo 08, §6)
    if (!sem.intentarAdquirir()) throw new BulkheadLlenoError(dependencia);
    try { return await fn(); } finally { sem.liberar(); }
  }
}
```

**`intentarAdquirir()` y no `await adquirir()`.** Si no hay slot, **rechazás
rápido**. Una cola ilimitada esperando un slot es el mismo problema con un
nombre más amable: la latencia crece hasta que el proceso muere.

### 4.3 El circuit breaker, evaluado ANTES de pedir el recurso

```ts
@Injectable()
export class CircuitBreaker {
  private estado: 'CLOSED' | 'OPEN' | 'HALF' = 'CLOSED';
  private abiertoEn = 0;
  private ventana: boolean[] = [];        // true = fallo

  private readonly UMBRAL = 0.5;         // TASA, no cantidad
  private readonly VOLUMEN_MINIMO = 20;  // no abrir con 3 requests
  private readonly COOLDOWN_MS = 10_000;

  permite(): boolean {
    if (this.estado === 'CLOSED') return true;
    if (this.estado === 'OPEN' && Date.now() - this.abiertoEn >= this.COOLDOWN_MS) {
      this.estado = 'HALF';
      return true;                        // una sonda
    }
    return this.estado === 'HALF';
  }

  registrar(esFallo: boolean) {
    if (this.estado === 'HALF') {
      this.estado = esFallo ? 'OPEN' : 'CLOSED';
      if (esFallo) this.abiertoEn = Date.now();
      this.ventana = [];
      return;
    }
    this.ventana.push(esFallo);
    if (this.ventana.length > 100) this.ventana.shift();
    if (this.ventana.length >= this.VOLUMEN_MINIMO) {
      const tasa = this.ventana.filter(Boolean).length / this.ventana.length;
      if (tasa >= this.UMBRAL) { this.estado = 'OPEN'; this.abiertoEn = Date.now(); this.ventana = []; }
    }
  }
}
```

### 4.4 Cómo se combinan — el orden importa

```ts
@Injectable()
export class RecomendacionesClient {
  async obtener(userId: string): Promise<Producto[]> {
    // 1. BREAKER PRIMERO. Antes de pedir cualquier recurso.
    if (!this.breaker.permite()) {
      this.metricas.increment('reco.fallback', { motivo: 'breaker_abierto' });
      return this.genericas();                    // 1 ms, sin tocar el pool
    }

    try {
      // 2. BULKHEAD: ¿hay slot para esta dependencia?
      return await this.bulkhead.ejecutar('recomendaciones', async () => {
        // 3. TIMEOUT con cancelación REAL
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300);   // p99 sano × ~2, no 5 s
        try {
          const r = await this.http.get(`/reco/${userId}`, { signal: ctrl.signal });
          this.breaker.registrar(false);
          return r.data;
        } finally { clearTimeout(timer); }
      });
    } catch (e) {
      // Sólo los fallos de la DEPENDENCIA abren el breaker, no los de negocio
      if (esFalloDeInfraestructura(e)) this.breaker.registrar(true);
      this.metricas.increment('reco.fallback', { motivo: nombreDe(e) });
      return this.genericas();                    // 4. DEGRADACIÓN
    }
  }

  private genericas(): Producto[] {
    return this.cacheLocal.get('productos:populares') ?? [];   // último valor conocido
  }
}
```

**Los cuatro detalles que hacen que esto funcione:**

1. **El breaker se evalúa ANTES de pedir el recurso.** Si lo consultás después
   de adquirir la conexión, ya ocupaste lo que querías proteger.
2. **El timeout es 300 ms, no 5 s.** El p99 sano era 50 ms: `50 × 2` con
   margen. Un timeout de 5 s para una dependencia de 50 ms no protege de nada
   — sólo define cuánto tiempo retenés el recurso cuando algo se rompe.
   **Es el número que convirtió este incidente en un incidente.**
3. **`AbortController`**, y no sólo un `Promise.race`. Sin él el `await` vence
   pero **la request sigue en vuelo**, ocupando el socket que querías liberar.
4. **El fallback no es un error**: devuelve algo útil. Un breaker abierto sin
   degradación convierte "lento" en "error rápido", que es mejor pero sigue
   siendo un error.

### 4.5 Clasificar los errores

```ts
function esFalloDeInfraestructura(e: unknown): boolean {
  if (e instanceof BulkheadLlenoError) return false;   // somos nosotros, no ellos
  if (e?.name === 'AbortError') return true;           // timeout
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET') return true;
  if (e?.response?.status >= 500) return true;
  return false;                                         // 4xx: la dependencia funcionó
}
```

Un `404` o un `422` **no son fallos de la dependencia**: la dependencia
funcionó perfecto y te dijo que no. Si cuentan para el breaker, un endpoint
que legítimamente devuelve muchos `404` te corta el servicio.

Y `BulkheadLlenoError` tampoco cuenta: es **tu** límite, no un fallo de ellos.
Contarlo crea un lazo donde la saturación propia abre el breaker.

### 4.6 El breaker que mira la latencia, no sólo los errores

Éste es el caso del incidente, y el que la mayoría de las librerías no cubre:

```ts
// Un servicio que responde 200 OK en 30 segundos NUNCA abre un breaker
// que sólo cuenta errores. Y es exactamente el peor caso.
registrarLatencia(ms: number) {
  this.ventanaLatencia.push(ms);
  if (this.ventanaLatencia.length > 100) this.ventanaLatencia.shift();
  const p95 = percentil(this.ventanaLatencia, 95);
  if (p95 > this.LATENCIA_INACEPTABLE_MS) this.registrar(true);   // lento == fallo
}
```

> **Para un pool compartido, lento es peor que caído.** Caído devuelve error en
> 1 ms y no retiene nada. Lento retiene tu recurso 5 segundos por request.

## 5. Por qué así y no de otra forma

### ❌ "Agrandamos el pool a 500 conexiones"

Es lo primero que se intenta y **mueve el problema de lugar**:

- Cada conexión de Postgres es **un proceso del sistema operativo** con varios
  MB de memoria. 500 conexiones activas generan contención de CPU por context
  switching mucho antes de dar throughput útil
  ([módulo 05](../modules/05-bases-de-datos/)).
- **`max_connections` de Postgres** se agota: `FATAL: sorry, too many clients
  already`, que aparece como 500 en endpoints perfectamente sanos.
- Y el fondo: **no arregla nada**. Si recomendaciones tarda 30 s, con 500
  conexiones tarda un poco más en agotarlas. La próxima dependencia lenta
  vuelve a tumbar todo.

**Agrandar el pool trata el síntoma. El problema es que se comparte.**

### ❌ "Le bajamos el timeout a 500 ms y listo"

**Ayuda muchísimo** y no alcanza:

```
L = 100 req/s × 0,5 s = 50 conexiones    ← justo el pool completo
```

Seguís pudiendo agotar el pool, sólo que hace falta un poco más de tráfico. Y
el día que `/home` reciba 200 req/s, volvés al mismo incidente.

Bajar el timeout es **necesario** (el de 5 s era absurdo para una dependencia
de 50 ms) y **no es suficiente**: no cambia el hecho de que los dos endpoints
compiten por el mismo recurso.

### ❌ "Ponemos un circuit breaker y alcanza"

Mejora de 26% a 79%, y **no llega al 100% por una razón estructural**: el
breaker es **reactivo**. Entre que la dependencia se degrada y que junta
evidencia suficiente, **el pool ya se saturó**. Y cada paso a HALF-OPEN deja
entrar sondas que vuelven a ocupar conexiones por 5 segundos.

El bulkhead protege **desde el primer milisegundo** porque no necesita
detectar nada. **No son alternativas: el breaker sin bulkhead te protege
después del daño.**

### ❌ "Ponemos un bulkhead y alcanza"

Deja el checkout en 100%, y `/home` queda esperando timeouts indefinidamente:
quema su propio presupuesto, sirve páginas lentas, y mantiene carga sobre un
servicio que está tratando de recuperarse. El breaker es lo que lo convierte
en un fallback instantáneo.

**Los dos, y en ese orden: bulkhead para que el daño no salga, breaker para
que no dure.**

### ❌ "Separamos recomendaciones en otro servicio y se arregla"

Mover `/home` a otro proceso **sí** aísla el event loop y la memoria — y es una
forma válida de bulkhead, la más fuerte. Pero **si los dos servicios apuntan a
la misma base con pools generosos, el problema vuelve**: el recurso compartido
pasa a ser `max_connections` de Postgres.

El aislamiento tiene que llegar hasta el recurso realmente escaso, y para
eso está **PgBouncer** con pools por usuario/base.

### ❌ "Hacemos la llamada en paralelo con `Promise.all`"

No tiene nada que ver con el problema. El paralelismo no libera conexiones:
las toma todas **al mismo tiempo**. Y sin `AbortController`, un
`Promise.race` con timeout **vence el `await` y deja la request en vuelo**,
que es el peor de los mundos: el usuario recibe su respuesta y el socket sigue
ocupado.

### ✅ El inventario de dependencias, revisado

La lección que queda después del post-mortem:

> **"No crítico" es una afirmación sobre la FUNCIÓN, no sobre el RECURSO.**
> Recomendaciones no es crítico funcionalmente. Comparte el pool con el
> checkout, así que **es crítico operativamente.**

El ejercicio concreto que vale la pena hacer una vez: para cada dependencia,
dos columnas — *"si falla, ¿qué feature se degrada?"* y **"¿qué recursos
comparte con el camino crítico?"**. La segunda columna es la que nadie llena y
la que produce estos incidentes.

## 6. Cómo sabés que funciona

| Métrica | Qué te dice | Alerta |
| --- | --- | --- |
| **Uso del pool por nombre** (`critico` / `secundario`) | Cuál se está saturando | `> 80%` sostenido |
| **Tiempo de ADQUISICIÓN de conexión** (p99), separado del tiempo de query | **La métrica que falta en todos lados** | `> 50 ms` |
| **Rechazos del bulkhead**, por dependencia | El límite está trabajando | Tendencia |
| **Estado del breaker** (gauge 0/1/2) por dependencia | Qué está degradado ahora | Cualquier `OPEN` |
| **Tasa de fallbacks servidos** | Cuánto se degradó la experiencia | Pico |
| **p99 por dependencia**, no agregado | Detecta "lento" antes que "caído" | Regresión |

La segunda es la clave del diagnóstico de este caso. Si tu instrumentación
mide *"tiempo de query"*, este incidente es **invisible**: la query tardó 30
ms. Lo que tardó 5 segundos fue **conseguir la conexión**, y nadie lo mide
([módulo 01, C1](../modules/01-fundamentos/respuestas.md)).

**Cómo lo testeás — y esto sí se puede testear:**

```ts
it('el checkout sobrevive a una dependencia no crítica degradada', async () => {
  // Recomendaciones tarda 30 s
  servidorReco.setLatencia(30_000);

  const [checkout, home] = await Promise.all([
    cargar('/checkout', { rps: 100, durante: 60_000 }),
    cargar('/home',     { rps: 100, durante: 60_000 }),
  ]);

  expect(checkout.tasaExito).toBeGreaterThan(0.99);   // ← LA aserción del caso
  expect(checkout.p99).toBeLessThan(200);
  expect(home.tasaExito).toBeGreaterThan(0.95);        // degradado, no caído
  expect(home.fallbacks).toBeGreaterThan(0);           // el fallback se usó
});
```

Y una vez que existe, **va a CI**: es la prueba de que nadie va a volver a
unificar los pools "para simplificar". Es un test de arquitectura, no de
lógica.

**Game day.** Esto se verifica en producción, con un experimento controlado:
inyectar 30 s de latencia en recomendaciones durante 5 minutos, en horario de
baja carga, y confirmar que el checkout no se mueve. Es el único modo de saber
que la configuración que escribiste hace seis meses sigue vigente.

## 7. El costo

1. **Capacidad "desperdiciada" por diseño.** El pool secundario tiene 15
   conexiones que el crítico no puede usar ni cuando está ocioso. **Ese
   desperdicio ES la protección**, y hay que defenderlo cuando alguien
   proponga unificar "para aprovechar mejor".
2. **Más configuración que mantener**: dos pools, N semáforos, N breakers, con
   sus umbrales. Y cada umbral envejece: el p99 de hoy no es el de hace un año.
3. **Los fallbacks son código de producción que casi nunca corre**, y por lo
   tanto el menos probado. Si no lo testeás explícitamente, va a estar roto el
   día que haga falta.
4. **Complejidad de diagnóstico.** Ahora un error puede venir de la
   dependencia, del bulkhead o del breaker. Sin métricas que los distingan,
   agregaste tres capas de misterio.
5. **El breaker puede abrirse de más** con umbrales mal calibrados y degradar
   la experiencia sin necesidad. Es un parámetro que hay que mirar.

**Y lo más barato de todo, que es lo primero que hay que hacer:** poner un
timeout razonable. El incidente existió porque había un timeout de **5
segundos** hacia una dependencia de **50 milisegundos**. Ese solo número, bien
elegido, habría convertido una caída del checkout en una página de inicio un
poco lenta.

---

## Fuentes

- **Michael Nygard**, *Release It!* (2ª ed.), caps. 4-5 — el bulkhead y el
  circuit breaker, con los post-mortems que los originaron.
- **Netflix**, *Hystrix: How it works* — bulkhead por thread pool a escala:
  <https://github.com/Netflix/Hystrix/wiki/How-it-Works>
- **AWS Builders' Library**, *Using load shedding to avoid overload*:
  <https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/>
- **Google SRE Book**, *Addressing Cascading Failures*:
  <https://sre.google/sre-book/addressing-cascading-failures/>

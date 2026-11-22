/**
 * Módulo 08 — Circuit breaker y bulkhead: cómo una dependencia NO crítica
 * te tumba el checkout.
 *
 *   node modules/08-fiabilidad/circuit-breaker.ts
 *
 * Dos endpoints que comparten el pool de conexiones:
 *   /checkout  -> crítico, usa una dependencia rápida (30 ms)
 *   /home      -> usa "recomendaciones", que en t=30s se degrada a 30 SEGUNDOS
 *
 * Recomendaciones no es crítico: si falla, se muestran recomendaciones
 * genéricas y nadie se entera. Mirá qué le pasa igual al checkout.
 */

const PASO_MS = 10;
const DURACION_MS = 120_000;
const DEGRADA_EN_MS = 30_000;

const POOL_TOTAL = 50;
const TIMEOUT_MS = 5_000;          // timeout hacia la dependencia
const RPS_CHECKOUT = 100;
const RPS_HOME = 100;

const LAT_CHECKOUT_MS = 30;
const LAT_RECO_SANA_MS = 50;
const LAT_RECO_DEGRADADA_MS = 30_000;

// Circuit breaker
const UMBRAL_FALLOS = 0.5;         // 50% de fallos en la ventana
const VOLUMEN_MINIMO = 20;         // no abrir con 3 requests
const COOLDOWN_MS = 10_000;

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

type Config = { breaker: boolean; bulkhead: boolean };

interface Req { endpoint: 'checkout' | 'home'; llegada: number; slotEn?: number; }
interface Stats { total: number; ok: number; latencias: number[]; }

function simular(cfg: Config): { checkout: Stats; home: Stats; fallbacks: number } {
  // Con bulkhead, cada endpoint tiene su propio presupuesto de conexiones.
  const poolCheckout = cfg.bulkhead ? POOL_TOTAL / 2 : POOL_TOTAL;
  const poolHome = cfg.bulkhead ? POOL_TOTAL / 2 : POOL_TOTAL;
  let usoCheckout = 0, usoHome = 0, usoCompartido = 0;

  // Con bulkhead, cada endpoint tiene su propia cola de espera además de su
  // propio pool. Sin bulkhead comparten pool Y cola: por eso un /home lento
  // bloquea a un /checkout que está justo detrás.
  const colas: Record<'checkout' | 'home', Req[]> = { checkout: [], home: [] };
  const enVuelo: { req: Req; libreEn: number; ok: boolean }[] = [];
  const stats: Record<string, Stats> = {
    checkout: { total: 0, ok: 0, latencias: [] },
    home: { total: 0, ok: 0, latencias: [] },
  };
  let fallbacks = 0;

  // Estado del breaker de "recomendaciones"
  let estado: 'CLOSED' | 'OPEN' | 'HALF' = 'CLOSED';
  let abiertoEn = 0;
  let ventana: boolean[] = [];     // true = fallo

  const registrar = (esFallo: boolean) => {
    ventana.push(esFallo);
    if (ventana.length > 100) ventana.shift();
    if (estado === 'CLOSED' && ventana.length >= VOLUMEN_MINIMO) {
      const tasa = ventana.filter(Boolean).length / ventana.length;
      if (tasa >= UMBRAL_FALLOS) { estado = 'OPEN'; abiertoEn = t; ventana = []; }
    } else if (estado === 'HALF') {
      if (esFallo) { estado = 'OPEN'; abiertoEn = t; }
      else { estado = 'CLOSED'; ventana = []; }
    }
  };

  let t = 0;
  for (; t < DURACION_MS; t += PASO_MS) {
    const latReco = t >= DEGRADA_EN_MS ? LAT_RECO_DEGRADADA_MS : LAT_RECO_SANA_MS;

    // --- liberar lo que terminó ---
    for (let i = enVuelo.length - 1; i >= 0; i--) {
      if (enVuelo[i].libreEn > t) continue;
      const { req, ok } = enVuelo[i];
      if (cfg.bulkhead) { req.endpoint === 'checkout' ? usoCheckout-- : usoHome--; }
      else usoCompartido--;
      const lat = enVuelo[i].libreEn - req.llegada;
      stats[req.endpoint].latencias.push(lat);
      if (ok) stats[req.endpoint].ok++;
      if (req.endpoint === 'home') registrar(!ok);
      enVuelo.splice(i, 1);
    }

    // --- llegadas ---
    for (const [endpoint, rps] of [['checkout', RPS_CHECKOUT], ['home', RPS_HOME]] as const) {
      const n = (rps * PASO_MS) / 1000;
      for (let k = 0; k < n; k++) {
        stats[endpoint].total++;
        // El breaker se evalúa ANTES de pedir una conexión: ése es el punto.
        if (endpoint === 'home' && cfg.breaker) {
          if (estado === 'OPEN' && t - abiertoEn < COOLDOWN_MS) {
            fallbacks++; stats.home.ok++; stats.home.latencias.push(1);   // fallback en 1 ms
            continue;
          }
          if (estado === 'OPEN') estado = 'HALF';                          // probamos de nuevo
        }
        colas[endpoint].push({ endpoint, llegada: t });
      }
    }

    // --- asignar conexiones ---
    const arrancar = (req: Req) => {
      const latDep = req.endpoint === 'checkout' ? LAT_CHECKOUT_MS : latReco;
      const duracion = Math.min(latDep, TIMEOUT_MS);
      const ok = latDep <= TIMEOUT_MS && (t - req.llegada) + duracion <= TIMEOUT_MS;
      enVuelo.push({ req, libreEn: t + duracion, ok });
    };

    if (cfg.bulkhead) {
      // Cada endpoint contra SU pool, sin bloquearse entre sí.
      while (colas.checkout.length > 0 && usoCheckout < poolCheckout) {
        usoCheckout++; arrancar(colas.checkout.shift()!);
      }
      while (colas.home.length > 0 && usoHome < poolHome) {
        usoHome++; arrancar(colas.home.shift()!);
      }
    } else {
      // Pool compartido = UNA cola de espera. El que llegó primero, primero.
      while (usoCompartido < POOL_TOTAL && (colas.checkout.length > 0 || colas.home.length > 0)) {
        const c = colas.checkout[0], h = colas.home[0];
        const cual: 'checkout' | 'home' =
          !h ? 'checkout' : !c ? 'home' : (c.llegada <= h.llegada ? 'checkout' : 'home');
        usoCompartido++; arrancar(colas[cual].shift()!);
      }
    }

    // --- los que llevan demasiado esperando, se rinden ---
    for (const nombre of ['checkout', 'home'] as const) {
      const q = colas[nombre];
      while (q.length > 0 && t - q[0].llegada > TIMEOUT_MS) {
        q.shift();
        stats[nombre].latencias.push(TIMEOUT_MS);
        if (nombre === 'home') registrar(true);
      }
    }
  }

  return { checkout: stats.checkout, home: stats.home, fallbacks };
}

const p99 = (xs: number[]) => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil(0.99 * o.length) - 1)];
};

console.log('='.repeat(84));
console.log('  "Recomendaciones" (NO crítico) se degrada a 30 s. Pool compartido de ' + POOL_TOTAL + ' conexiones.');
console.log('='.repeat(84));
console.log(`  /checkout: ${RPS_CHECKOUT} req/s, dependencia de ${LAT_CHECKOUT_MS} ms. NO usa recomendaciones.`);
console.log(`  /home:     ${RPS_HOME} req/s, usa recomendaciones. Timeout ${TIMEOUT_MS / 1000} s.\n`);
console.log('  configuración                /checkout éxito   p99 checkout   /home éxito   fallbacks');
console.log('  ' + '-'.repeat(82));

const CONFIGS: [string, Config][] = [
  ['sin protección', { breaker: false, bulkhead: false }],
  ['circuit breaker', { breaker: true, bulkhead: false }],
  ['bulkhead (pools separados)', { breaker: false, bulkhead: true }],
  ['breaker + bulkhead', { breaker: true, bulkhead: true }],
];

for (const [nombre, cfg] of CONFIGS) {
  const r = simular(cfg);
  const okCheckout = (r.checkout.ok / r.checkout.total) * 100;
  const okHome = (r.home.ok / r.home.total) * 100;
  const icono = okCheckout > 95 ? '✅' : okCheckout > 60 ? '⚠️ ' : '💀';
  console.log(
    `  ${nombre.padEnd(28)} ${fmt(okCheckout, 1).padStart(13)} %   ${fmt(p99(r.checkout.latencias)).padStart(9)} ms   ` +
      `${fmt(okHome, 1).padStart(9)} %   ${fmt(r.fallbacks).padStart(9)}  ${icono}`,
  );
}

console.log(`
  LA COLUMNA QUE IMPORTA ES LA PRIMERA.

  /checkout NO usa recomendaciones. No la importa, no la llama, no sabe
  que existe. Y sin protección, el checkout se cae igual.

  POR QUÉ: cada request de /home toma una conexión del pool y la retiene
  los ${TIMEOUT_MS / 1000} segundos completos del timeout. Por la Ley de Little (módulo 01):

     ${RPS_HOME} req/s × ${TIMEOUT_MS / 1000} s = ${fmt((RPS_HOME * TIMEOUT_MS) / 1000)} conexiones necesarias

  El pool tiene ${POOL_TOTAL}. /home se las come todas y /checkout se queda
  esperando una conexión que nunca llega. **Una dependencia no crítica
  tumbó la crítica a través de un recurso compartido.**

  Es exactamente el mismo mecanismo del módulo 01 (C2) y del módulo 02
  (B5): el fallo no se propaga por la dependencia, se propaga por el
  POOL.

  QUÉ HACE CADA PATRÓN

  CIRCUIT BREAKER. Después de ver suficientes fallos deja de intentar:
  /home devuelve recomendaciones genéricas en 1 ms SIN pedir una
  conexión, y el pool se libera. El checkout pasa del 26% al 79%.

  Pero fijate que NO llega al 100%, y el motivo es importante: el
  breaker es REACTIVO. Entre que la dependencia se degrada y que el
  breaker junta evidencia suficiente para abrirse, el pool ya se
  saturó — y cada vez que pasa a HALF-OPEN deja entrar sondas que
  vuelven a ocupar conexiones por 5 segundos. Acorta el daño; no lo
  evita.

  Lo clave de implementación: el breaker se evalúa ANTES de pedir la
  conexión. Si lo ponés después, ya ocupaste el recurso que querías
  proteger y no sirve de nada.

  BULKHEAD. Pools separados: /home sólo puede agotar SU mitad. El
  checkout queda en 100% de éxito y p99 de 30 ms — como si no hubiera
  pasado nada, porque para él no pasó nada.

  Y acá está lo interesante: el bulkhead salva al checkout SIN SABER
  NADA de qué se rompió. No necesita detectar, ni contar fallos, ni
  decidir. Es protección estructural, y por eso funciona desde el
  primer milisegundo.

  LA DIFERENCIA ENTRE LOS DOS, y es la que conviene decir en una
  entrevista:

     El BULKHEAD evita que el daño se propague. (preventivo)
     El BREAKER acorta la duración del daño.    (reactivo)

     No son alternativas: el breaker sin bulkhead te protege DESPUÉS de
     que el pool compartido ya se agotó, y el bulkhead sin breaker deja
     a /home esperando timeouts de 5 s para siempre, quemando su propio
     presupuesto y dándole al usuario una página lenta.

  Y EL BREAKER NO PROTEGE A LA DEPENDENCIA CAÍDA: TE PROTEGE A VOS.
  Que de paso le saques carga de encima mientras se recupera es un
  efecto secundario agradable, no el objetivo.

  LOS ERRORES DE CONFIGURACIÓN MÁS COMUNES

   - Umbral por CANTIDAD ("10 fallos") en vez de por TASA. 10 de 10 y
     10 de 100.000 no son lo mismo. Usá tasa + volumen mínimo.
   - Abrir por errores de NEGOCIO. Un 404 o un 422 no son fallos de la
     dependencia: sólo cuentan timeouts, 5xx y errores de conexión.
   - Un breaker GLOBAL para todo el servicio. Si es por servicio y no
     por dependencia (o por host), un endpoint lento te corta todo.
   - Sin FALLBACK. Un breaker abierto sin plan de degradación convierte
     "lento" en "error rápido": mejor, pero sigue siendo un error.
`);

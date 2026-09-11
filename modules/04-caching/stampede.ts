/**
 * Módulo 04 — Cache stampede: cuatro estrategias, medidas.
 *
 *   node modules/04-caching/stampede.ts
 *
 * Escenario: 1.000 claves cacheadas, tráfico Zipf (la clave más popular se
 * lleva ~30% del tráfico), 5.000 req/s durante 30 segundos. Todas las claves
 * se poblaron al mismo tiempo — porque hubo un deploy, o porque se cayó y
 * volvió Redis — así que todas expiran juntas. La query a la base tarda 50 ms.
 *
 * Medimos el PICO de req/s contra la base. Ese pico es lo que te cae el
 * sistema; el promedio no dice nada.
 */

const N_CLAVES = 1_000;
const QPS = 20_000;
const DURACION_S = 30;
const TTL_MS = 10_000;
const LATENCIA_DB_MS = 50;
const LATENCIA_CACHE_MS = 1;

// ---------------------------------------------------------------------------
// Tráfico Zipf: unas pocas claves concentran casi todo el tráfico
// ---------------------------------------------------------------------------
const pesos = Array.from({ length: N_CLAVES }, (_, i) => 1 / Math.pow(i + 1, 1.1));
const total = pesos.reduce((a, b) => a + b, 0);
const acumulado: number[] = [];
let acc = 0;
for (const p of pesos) { acc += p / total; acumulado.push(acc); }

function elegirClave(): number {
  const r = Math.random();
  let lo = 0, hi = N_CLAVES - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (acumulado[m] < r) lo = m + 1; else hi = m; }
  return lo;
}

console.log('='.repeat(76));
console.log(`  ${N_CLAVES.toLocaleString('es-AR')} claves · ${QPS.toLocaleString('es-AR')} req/s · TTL ${TTL_MS / 1000}s · query ${LATENCIA_DB_MS} ms`);
console.log('='.repeat(76));
console.log(`  La clave #1 se lleva el ${(pesos[0] / total * 100).toFixed(0)}% del tráfico; las 10 primeras, el ${(pesos.slice(0, 10).reduce((a, b) => a + b, 0) / total * 100).toFixed(0)}%.`);
console.log('  Todas las claves se poblaron a la vez (deploy / Redis que volvió).\n');

// ---------------------------------------------------------------------------
// El simulador
// ---------------------------------------------------------------------------

interface Entrada {
  valorDesde: number;       // desde cuándo el valor está REALMENTE en el caché
  expiraEn: number;         // vencimiento duro
  refrescoDesde: number;    // vencimiento blando (sólo stale-while-revalidate)
  refrescandoHasta: number; // 0 = nadie está refrescando
}

type Estrategia = 'ttl plano' | 'ttl + jitter' | 'single-flight' | 'stale-while-revalidate';

interface Resultado { picoDb: number; totalDb: number; p99: number; p999: number; stale: number; }

function simular(estrategia: Estrategia): Resultado {
  const jitter = estrategia === 'ttl + jitter';
  const singleFlight = estrategia === 'single-flight' || estrategia === 'stale-while-revalidate';
  const swr = estrategia === 'stale-while-revalidate';

  const nuevoTtl = () => (jitter ? TTL_MS * (0.75 + Math.random() * 0.5) : TTL_MS);

  const cache: Entrada[] = Array.from({ length: N_CLAVES }, () => {
    const ttl = nuevoTtl();
    return { valorDesde: 0, expiraEn: ttl, refrescoDesde: ttl * 0.8, refrescandoHasta: 0 };
  });

  const dbPorSegundo = new Array(DURACION_S + 2).fill(0);
  const latencias: number[] = [];
  let totalDb = 0, servidoStale = 0;

  const nRequests = QPS * DURACION_S;
  const intervalo = 1000 / QPS;

  /** Lanza la query y programa cuándo el valor va a estar disponible. */
  const consultarBase = (e: Entrada, t: number) => {
    totalDb++;
    dbPorSegundo[Math.floor(t / 1000)]++;
    const ttl = nuevoTtl();
    e.valorDesde = t + LATENCIA_DB_MS;          // <-- clave: el caché NO se
    e.expiraEn = t + LATENCIA_DB_MS + ttl;      //     escribe hasta que la
    e.refrescoDesde = t + LATENCIA_DB_MS + ttl * 0.8;  //  query termina
  };

  for (let i = 0; i < nRequests; i++) {
    const t = i * intervalo;
    const e = cache[elegirClave()];

    // Hay valor usable sólo si ya llegó de la base y todavía no venció.
    const hayValor = t >= e.valorDesde && t < e.expiraEn;

    if (hayValor && !(swr && t >= e.refrescoDesde)) {
      latencias.push(LATENCIA_CACHE_MS);                       // hit limpio
      continue;
    }

    // --- stale-while-revalidate: hay valor pero está por vencer ---
    if (swr && hayValor) {
      latencias.push(LATENCIA_CACHE_MS);
      servidoStale++;
      if (e.refrescandoHasta <= t) {                            // uno solo refresca
        e.refrescandoHasta = t + LATENCIA_DB_MS;
        consultarBase(e, t);
      }
      continue;
    }

    // --- miss duro: no hay nada que servir ---
    if (singleFlight && e.refrescandoHasta > t) {
      latencias.push(e.refrescandoHasta - t);   // esperamos al que ya fue
      continue;
    }

    latencias.push(LATENCIA_DB_MS);
    if (singleFlight) e.refrescandoHasta = t + LATENCIA_DB_MS;
    consultarBase(e, t);
  }

  latencias.sort((a, b) => a - b);
  return {
    picoDb: Math.max(...dbPorSegundo),
    totalDb,
    p99: latencias[Math.ceil(0.99 * latencias.length) - 1],
    p999: latencias[Math.ceil(0.999 * latencias.length) - 1],
    stale: servidoStale,
  };
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

const ESTRATEGIAS: Estrategia[] = ['ttl plano', 'ttl + jitter', 'single-flight', 'stale-while-revalidate'];
const CAPACIDAD_DB = 2_000;

console.log('  estrategia                 pico req/s a la base   p99     p99.9   veredicto');
console.log('  ' + '-'.repeat(74));

const res: Record<string, Resultado> = {};
for (const est of ESTRATEGIAS) {
  const r = simular(est);
  res[est] = r;
  const veredicto = r.picoDb > CAPACIDAD_DB ? `💀 ${(r.picoDb / CAPACIDAD_DB).toFixed(1)}x la capacidad` : '✅ sano';
  console.log(
    `  ${est.padEnd(26)} ${r.picoDb.toLocaleString('es-AR').padStart(14)}   ` +
      `${r.p99.toFixed(0).padStart(4)} ms  ${r.p999.toFixed(0).padStart(5)} ms   ${veredicto}`,
  );
}

console.log(`
  (la base aguanta ${CAPACIDAD_DB.toLocaleString('es-AR')} req/s)

  CÓMO LEER ESTO

  TTL PLANO. Todas las claves expiran a la vez y cada request que llega en
  los ${LATENCIA_DB_MS} ms siguientes hace su propia query, porque ninguna terminó
  todavía de escribir el caché. Pico de ${res['ttl plano'].picoDb.toLocaleString('es-AR')} req/s: la base se cae, y
  al recuperarse todo vuelve a expirar junto. Es el dogpile clásico.

  TTL + JITTER. Cada clave expira en un momento distinto (TTL × 0,75-1,25).
  Y sin embargo el pico baja apenas: ${res['ttl + jitter'].picoDb.toLocaleString('es-AR')} req/s, todavía
  ${(res['ttl + jitter'].picoDb / CAPACIDAD_DB).toFixed(1)}x la capacidad de la base.

  ESTE ES EL RESULTADO MÁS IMPORTANTE DEL SCRIPT, y es contraintuitivo:
  el jitter resuelve la expiración MASIVA, no la CLAVE CALIENTE. La clave
  #1 se lleva el 18% del tráfico ella sola: cuando le toca expirar — en el
  momento que sea — hay ${(QPS * 0.18 * LATENCIA_DB_MS / 1000).toFixed(0)} requests llegando durante los ${LATENCIA_DB_MS} ms que
  tarda la query, y las ${(QPS * 0.18 * LATENCIA_DB_MS / 1000).toFixed(0)} van a la base. Desparramar los
  vencimientos no cambia nada de eso.

  Conclusión: jitter y single-flight resuelven problemas DISTINTOS y se
  usan JUNTOS. El jitter solo es una falsa sensación de seguridad.

  SINGLE-FLIGHT. Sólo la primera request va a la base; las demás esperan su
  resultado. Pico de ${res['single-flight'].picoDb.toLocaleString('es-AR')} req/s: ${(res['ttl plano'].picoDb / Math.max(res['single-flight'].picoDb, 1)).toFixed(0)}x menos que TTL plano, y por debajo
  de lo que la base aguanta. Es LA defensa contra el stampede.
  El costo no se ve en el p99 (${res['single-flight'].p99.toFixed(0)} ms, porque el 99% son hits) sino en
  el p99.9: ${res['single-flight'].p999.toFixed(0)} ms. Los que esperan pagan la query completa aunque
  no la hayan hecho ellos. Cambiaste carga de la base por latencia de cola.

  STALE-WHILE-REVALIDATE. Nadie espera nunca: se sirve el valor viejo
  (${res['stale-while-revalidate'].stale.toLocaleString('es-AR')} veces) mientras UNA request refresca en background.
  Mismo pico que single-flight (${res['stale-while-revalidate'].picoDb.toLocaleString('es-AR')} req/s) pero p99.9 de ${res['stale-while-revalidate'].p999.toFixed(0)} ms
  en vez de ${res['single-flight'].p999.toFixed(0)} ms: recuperaste la cola sin resignar protección.

  El costo de SWR NO es técnico: es de negocio. Aceptás servir datos
  vencidos. Para un catálogo de productos, perfecto. Para el saldo de una
  cuenta, no. Es la misma pregunta de siempre: ¿cuánta desactualización
  tolera este caso de uso?

  CÓMO IMPLEMENTAR SINGLE-FLIGHT EN REDIS (la pregunta de entrevista):

    SET lock:user:123 <token> NX PX 5000     <- uno solo gana
      ganó   -> consulta la base, escribe el caché, borra el lock
      perdió -> espera y reintenta el GET (o devuelve stale si lo tiene)

    El lock necesita TTL: si el que ganó se muere, nadie más consulta
    nunca. Y el TTL tiene que ser mayor que la query y menor que la
    paciencia del usuario. (Módulo 06: esto es un lock distribuido con
    todos sus problemas.)

    En un solo proceso Node alcanza con un Map<clave, Promise>: las
    requests concurrentes del MISMO pod comparten la promesa. Es la
    primera línea de defensa, cuesta 5 líneas, y reduce el stampede
    por un factor igual a tu concurrencia por pod.
`);

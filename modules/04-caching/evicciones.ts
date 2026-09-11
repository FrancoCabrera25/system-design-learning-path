/**
 * Módulo 04 — Políticas de evicción: LRU vs LFU vs random.
 *
 *   node modules/04-caching/evicciones.ts
 *
 * Dos escenarios:
 *   A) Tráfico normal (Zipf). ¿Cuánta diferencia hace la política?
 *   B) El job nocturno que recorre toda la tabla. Acá LRU se desarma.
 *
 * El escenario B es una pregunta de entrevista frecuente y un incidente real
 * frecuentísimo: "el caché anduvo bien seis meses y de golpe, cada noche a
 * las 2 AM, la base se satura".
 */

const N_CLAVES = 10_000;
const CAPACIDAD = 200;          // el caché entra el 2% de las claves
const N_REQUESTS = 300_000;

// ---------------------------------------------------------------------------
// Tráfico Zipf
// ---------------------------------------------------------------------------
const pesos = Array.from({ length: N_CLAVES }, (_, i) => 1 / Math.pow(i + 1, 1.0));
const total = pesos.reduce((a, b) => a + b, 0);
const acum: number[] = [];
let acc = 0;
for (const p of pesos) { acc += p / total; acum.push(acc); }

function claveZipf(): number {
  const r = Math.random();
  let lo = 0, hi = N_CLAVES - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (acum[m] < r) lo = m + 1; else hi = m; }
  return lo;
}

// ---------------------------------------------------------------------------
// Las tres políticas
// ---------------------------------------------------------------------------

interface Cache {
  get(k: number): boolean;   // true = hit
  put(k: number): void;
}

/** LRU: un Map de JS mantiene el orden de inserción; reinsertar = "usar". */
function crearLRU(cap: number): Cache {
  const m = new Map<number, true>();
  return {
    get(k) {
      if (!m.has(k)) return false;
      m.delete(k); m.set(k, true);            // lo movemos al final = reciente
      return true;
    },
    put(k) {
      if (m.has(k)) { m.delete(k); m.set(k, true); return; }
      if (m.size >= cap) m.delete(m.keys().next().value as number);  // el más viejo
      m.set(k, true);
    },
  };
}

/** LFU: contamos usos y desalojamos el menos frecuente. */
function crearLFU(cap: number): Cache {
  const usos = new Map<number, number>();
  return {
    get(k) {
      if (!usos.has(k)) return false;
      usos.set(k, usos.get(k)! + 1);
      return true;
    },
    put(k) {
      if (usos.has(k)) return;
      if (usos.size >= cap) {
        let peor = -1, min = Infinity;
        for (const [kk, c] of usos) if (c < min) { min = c; peor = kk; }
        usos.delete(peor);
      }
      usos.set(k, 1);
    },
  };
}

/** Random: desalojamos cualquiera. Sin metadata, sin orden, sin nada. */
function crearRandom(cap: number): Cache {
  const s = new Set<number>();
  return {
    get: (k) => s.has(k),
    put(k) {
      if (s.has(k)) return;
      if (s.size >= cap) {
        const arr = [...s];
        s.delete(arr[Math.floor(Math.random() * arr.length)]);
      }
      s.add(k);
    },
  };
}

const POLITICAS: [string, (c: number) => Cache][] = [
  ['LRU', crearLRU],
  ['LFU', crearLFU],
  ['Random', crearRandom],
];

// ---------------------------------------------------------------------------
// A) Tráfico normal
// ---------------------------------------------------------------------------
console.log('='.repeat(74));
console.log(`  A) TRÁFICO NORMAL — ${N_CLAVES.toLocaleString('es-AR')} claves, caché de ${CAPACIDAD} (el ${(CAPACIDAD / N_CLAVES * 100).toFixed(0)}%), Zipf`);
console.log('='.repeat(74));
console.log('\n  política     hit rate');
console.log('  ' + '-'.repeat(26));

const baseHit: Record<string, number> = {};
for (const [nombre, crear] of POLITICAS) {
  const c = crear(CAPACIDAD);
  let hits = 0;
  for (let i = 0; i < N_REQUESTS; i++) {
    const k = claveZipf();
    if (c.get(k)) hits++; else c.put(k);
  }
  baseHit[nombre] = (hits / N_REQUESTS) * 100;
  console.log(`  ${nombre.padEnd(10)} ${baseHit[nombre].toFixed(1).padStart(7)} %`);
}

console.log(`
  Con un caché que entra apenas el 2% de las claves, las tres políticas
  dan hit rates altos: así de sesgado es el tráfico real. La diferencia
  entre ellas existe pero es modesta.

  Esto es lo que hace que la gente diga "la política de evicción da
  igual". Con tráfico normal, casi.`);

// ---------------------------------------------------------------------------
// B) El job nocturno
// ---------------------------------------------------------------------------
const CALENTAMIENTO = 200_000;   // tráfico normal antes de que arranque el job
const VENTANA = 100_000;         // requests normales DURANTE la ventana del job
const SCAN_POR_REQUEST = 3;      // el job es agresivo: lee 3 claves por cada
                                 // request normal (un export no va despacio)

console.log(`\n${'='.repeat(74)}`);
console.log('  B) LAS 2 AM — un job recorre TODA la tabla mientras sigue el tráfico');
console.log('='.repeat(74));
console.log(`\n  El job hace un scan secuencial: pide cada clave UNA vez y no vuelve.`);
console.log(`  Es ${SCAN_POR_REQUEST} lecturas del job por cada request de usuario (un export, un`);
console.log(`  reporte, un backfill). Medimos SÓLO el hit rate del tráfico de usuario`);
console.log(`  durante la ventana.\n`);
console.log('  política     hit rate    vs. normal      claves calientes que sobreviven');
console.log('  ' + '-'.repeat(72));

for (const [nombre, crear] of POLITICAS) {
  const c = crear(CAPACIDAD);

  // Calentamiento: el caché se llena con lo que de verdad se pide
  for (let i = 0; i < CALENTAMIENTO; i++) {
    const k = claveZipf();
    if (!c.get(k)) c.put(k);
  }

  // Ventana del job
  let hits = 0, scan = 0;
  for (let i = 0; i < VENTANA; i++) {
    for (let j = 0; j < SCAN_POR_REQUEST; j++) {
      const k = scan++ % N_CLAVES;          // secuencial, una sola vez cada una
      if (!c.get(k)) c.put(k);
    }
    const k = claveZipf();
    if (c.get(k)) hits++; else c.put(k);
  }

  // ¿Cuántas del top 200 (lo que DEBERÍA estar cacheado) siguen adentro?
  let sobreviven = 0;
  for (let k = 0; k < CAPACIDAD; k++) if (c.get(k)) sobreviven++;

  const hr = (hits / VENTANA) * 100;
  const delta = hr - baseHit[nombre];
  const icono = delta < -8 ? '💀' : delta < -3 ? '⚠️ ' : '✅';
  console.log(
    `  ${nombre.padEnd(10)} ${hr.toFixed(1).padStart(7)} %    ${delta.toFixed(1).padStart(6)} pts  ${icono}` +
      `      ${String(sobreviven).padStart(4)} de ${CAPACIDAD}`,
  );
}

console.log(`
  ACÁ ESTÁ EL PUNTO DEL SCRIPT.

  LRU se desarma. Su criterio es "lo usado más recientemente se queda", y
  el job acaba de "usar recientemente" diez mil claves que nadie va a
  volver a pedir nunca. Cada una de esas claves desaloja una clave
  caliente. El caché se llena de basura fría y el tráfico real empieza a
  pegarle a la base.

  LFU aguanta. Su criterio es "lo MÁS PEDIDO se queda". Una clave del
  scan tiene 1 acceso; una clave caliente tiene miles. La del scan entra
  y sale enseguida sin tocar lo importante.

  RANDOM cae igual que LRU. Y tiene sentido: tampoco distingue caliente
  de frío. La diferencia es que se auto-repara más rápido cuando el job
  termina (no arrastra un orden de recencia envenenado), pero durante la
  ventana sufre lo mismo. Que en el escenario A quede apenas 5 puntos por
  debajo de LRU con cero metadata es el dato interesante de random: es
  barato y no es ridículo. Pero no protege de esto.

  La columna de la derecha es la que lo explica todo: de las 200 claves
  que DEBERÍAN estar cacheadas, LRU conserva 20 y LFU conserva 142.

  EN PRODUCCIÓN ESTO SE VE ASÍ: "el sistema anda perfecto, salvo todas
  las noches entre las 2 y las 3, que la base se satura y no sabemos por
  qué". El culpable es un reporte, un export a un data warehouse, o un
  backfill — combinado con maxmemory-policy allkeys-lru.

  QUÉ HACER
    1. maxmemory-policy allkeys-lfu (Redis >= 4.0). Cambio de una línea.
    2. Que los jobs analíticos NO pasen por el caché de la aplicación
       (leer de una réplica, con su propia conexión y sin cachear).
    3. Instancias de Redis separadas para cargas con patrones distintos.
    4. Si el job DEBE cachear, ponerle TTL muy corto a lo que escribe.

  Y la versión corta para una entrevista:

    "LRU optimiza por recencia y LFU por frecuencia. Cualquier acceso
     secuencial masivo —un scan, un backfill, un crawler— es reciente
     pero no frecuente, así que envenena un LRU y no toca un LFU.
     Por eso el default que elijo en un caché de aplicación es
     allkeys-lfu."
`);

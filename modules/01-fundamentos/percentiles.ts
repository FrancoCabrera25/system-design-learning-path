/**
 * Módulo 01 — Percentiles y amplificación de cola.
 *
 *   node modules/01-fundamentos/percentiles.ts
 *
 * Dos demostraciones:
 *   A) El promedio miente: una distribución realista de latencias tiene
 *      promedio inocente y p99 catastrófico.
 *   B) Amplificación de cola: cuando una request depende de N servicios en
 *      paralelo, el p99 de cada uno se convierte en el caso común del usuario.
 */

const N_MUESTRAS = 200_000;

/**
 * Latencia realista de un endpoint: casi todo rápido, con una cola larga.
 * Mezcla de tres poblaciones, que es lo que se ve en producción de verdad:
 *   - 94%: camino feliz, caché caliente        (~15-40 ms)
 *   - 5% : cache miss, va a la base            (~60-200 ms)
 *   - 1% : GC pause / reintento / vecino ruidoso (~400-2500 ms)
 */
function muestraLatencia(): number {
  const r = Math.random();
  if (r < 0.94) return 15 + Math.random() * 25;
  if (r < 0.99) return 60 + Math.random() * 140;
  return 400 + Math.random() * 2100;
}

function percentil(ordenadas: number[], p: number): number {
  const idx = Math.min(ordenadas.length - 1, Math.ceil((p / 100) * ordenadas.length) - 1);
  return ordenadas[idx];
}

function ms(n: number): string {
  return `${n.toFixed(1).padStart(8)} ms`;
}

// ---------------------------------------------------------------------------
// A) El promedio miente
// ---------------------------------------------------------------------------

const muestras = Array.from({ length: N_MUESTRAS }, muestraLatencia);
const ordenadas = [...muestras].sort((a, b) => a - b);
const promedio = muestras.reduce((a, b) => a + b, 0) / muestras.length;

console.log('='.repeat(68));
console.log('A) UNA SOLA DEPENDENCIA — el promedio vs. los percentiles');
console.log('='.repeat(68));
console.log(`  muestras   ${N_MUESTRAS.toLocaleString('es-AR')}`);
console.log(`  promedio  ${ms(promedio)}   <-- lo que muestra un dashboard mal hecho`);
console.log(`  p50       ${ms(percentil(ordenadas, 50))}`);
console.log(`  p90       ${ms(percentil(ordenadas, 90))}`);
console.log(`  p95       ${ms(percentil(ordenadas, 95))}`);
console.log(`  p99       ${ms(percentil(ordenadas, 99))}   <-- lo que sufre 1 de cada 100`);
console.log(`  p99.9     ${ms(percentil(ordenadas, 99.9))}`);
console.log(`  máximo    ${ms(ordenadas[ordenadas.length - 1])}`);

const qps = 10_000;
const malos = Math.round(qps * 0.01);
console.log(`\n  A ${qps.toLocaleString('es-AR')} req/s, ese "sólo 1%" son ${malos} usuarios por segundo`);
console.log(`  con latencia >= ${percentil(ordenadas, 99).toFixed(0)} ms. O sea ${(malos * 86400).toLocaleString('es-AR')} requests malos por día.`);

// ---------------------------------------------------------------------------
// B) Amplificación de cola con fan-out
// ---------------------------------------------------------------------------

const p99Individual = percentil(ordenadas, 99);

/** Simula una request de usuario que espera a N servicios en paralelo. */
function latenciaFanOut(n: number): number {
  let peor = 0;
  for (let i = 0; i < n; i++) peor = Math.max(peor, muestraLatencia());
  return peor;
}

console.log(`\n${'='.repeat(68)}`);
console.log('B) FAN-OUT — la request espera a N servicios en paralelo');
console.log('='.repeat(68));
console.log(`  (cada servicio individual tiene p99 = ${p99Individual.toFixed(0)} ms)\n`);
console.log('   N   p50 usuario   p99 usuario   % de usuarios que pega el p99 de UN servicio');
console.log('  ' + '-'.repeat(64));

for (const n of [1, 2, 5, 10, 20, 50, 100]) {
  const sims = 20_000;
  const obs = Array.from({ length: sims }, () => latenciaFanOut(n)).sort((a, b) => a - b);
  const afectados = obs.filter((x) => x >= p99Individual).length / sims;
  const teorico = 1 - Math.pow(0.99, n); // P(al menos uno de los N cae en su 1% lento)
  console.log(
    `  ${String(n).padStart(3)}  ${ms(percentil(obs, 50))}  ${ms(percentil(obs, 99))}` +
      `      ${(afectados * 100).toFixed(1).padStart(5)}%   (teórico ${(teorico * 100).toFixed(1)}%)`,
  );
}

console.log(`
  LEER ASÍ: con 100 dependencias en paralelo, el p99 de tus servicios
  pasa a ser el caso de ~63% de tus usuarios. Ya no es "la cola", es
  la experiencia normal.

  Qué se hace con esto (y qué se responde en una entrevista):
    1. Reducir el fan-out    -> menos dependencias por request.
    2. Timeout + degradación -> devolver algo incompleto a tiempo en vez
                                de algo completo tarde.
    3. Hedged requests       -> mandar la misma request a 2 réplicas y
                                quedarse con la primera que conteste;
                                cuesta ~5% más de carga y corta la cola.
    4. Atacar la CAUSA del p99 (GC, contención de locks, cache miss),
       no promediar más máquinas: escalar horizontalmente NO mejora el
       p99 si la causa es una pausa de GC en cada proceso.
`);

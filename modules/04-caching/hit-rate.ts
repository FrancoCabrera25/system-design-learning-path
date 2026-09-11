/**
 * Módulo 04 — La no linealidad del hit rate.
 *
 *   node modules/04-caching/hit-rate.ts
 *
 * Todo el mundo mira el hit rate como "qué tan rápido responde el caché".
 * El número que importa es el otro: cuántas lecturas NUNCA llegan a la base.
 */

const QPS = 60_000;
const L_CACHE = 1;      // ms
const L_ORIGEN = 50;    // ms
const CAPACIDAD_BASE = 8_000;   // req/s que aguanta la base antes de degradarse

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log('='.repeat(74));
console.log(`  ${fmt(QPS)} req/s · caché ${L_CACHE} ms · base ${L_ORIGEN} ms · base aguanta ${fmt(CAPACIDAD_BASE)} req/s`);
console.log('='.repeat(74));
console.log('\n  hit rate   latencia efectiva   req/s a la base    estado de la base');
console.log('  ' + '-'.repeat(70));

for (const hr of [0, 0.5, 0.8, 0.9, 0.94, 0.95, 0.98, 0.99, 0.995]) {
  const lat = hr * L_CACHE + (1 - hr) * L_ORIGEN;
  const aBase = QPS * (1 - hr);
  const uso = aBase / CAPACIDAD_BASE;
  const estado =
    uso > 1 ? `💀 ${(uso).toFixed(1)}x su capacidad` :
    uso > 0.7 ? `⚠️  ${(uso * 100).toFixed(0)} % (zona de riesgo)` :
    `✅ ${(uso * 100).toFixed(0)} %`;
  console.log(
    `  ${(hr * 100).toFixed(1).padStart(7)} %   ${lat.toFixed(1).padStart(13)} ms   ` +
      `${fmt(aBase).padStart(14)}    ${estado}`,
  );
}

console.log(`
  LO QUE HAY QUE VER: la columna de latencia es aburrida. La que importa
  es la de la base.

  De 90% a 95% de hit rate la latencia baja un 41%... pero la carga de la
  base se reduce A LA MITAD. De 95% a 99%, cinco veces más.

  Y leído al revés es una alarma:`);

const casos: [number, number][] = [[0.99, 0.94], [0.995, 0.98], [0.98, 0.90]];
console.log('\n     hit rate cae de    a       la base recibe');
console.log('  ' + '-'.repeat(52));
for (const [antes, despues] of casos) {
  const mult = (1 - despues) / (1 - antes);
  console.log(
    `     ${(antes * 100).toFixed(1).padStart(9)} %   ${(despues * 100).toFixed(0).padStart(4)} %` +
      `      ${mult.toFixed(0).padStart(6)}x el tráfico anterior`,
  );
}

console.log(`
  Una caída de 5 PUNTOS de hit rate multiplica por 6 la carga de la base.
  No hace falta que Redis se caiga: alcanza con que empeore un poco.

  Causas típicas de que el hit rate se degrade sin que nadie toque nada:
    - la memoria llegó al maxmemory y Redis empezó a evictar
    - un deploy cambió el formato de serialización -> todas las claves
      viejas son inservibles
    - una feature nueva agregó claves de baja reutilización que desalojan
      a las calientes (el problema del scan, ver evicciones.ts)
    - creció el catálogo y el "20% caliente" ya no entra en la memoria
      que tenías dimensionada

  POR ESO EL HIT RATE ES UNA MÉTRICA DE ALERTA, NO DE DASHBOARD.
  Alertá sobre la DERIVADA (cayó 3 puntos en una hora), no sobre el valor
  absoluto. Para cuando el valor absoluto te preocupe, la base ya está en
  llamas.`);

// ---------------------------------------------------------------------------
// La pregunta que hay que saber responder ANTES de que pase
// ---------------------------------------------------------------------------
console.log(`
${'='.repeat(74)}
  ¿QUÉ PASA SI REDIS SE CAE POR COMPLETO?
${'='.repeat(74)}

  Sin caché, la base recibe los ${fmt(QPS)} req/s completos.
  Aguanta ${fmt(CAPACIDAD_BASE)}.

     ${fmt(QPS / CAPACIDAD_BASE, 1)}x su capacidad  ->  💀 no se degrada: se cae

  Y ahí aparece la pregunta incómoda que conviene hacerse en frío:

    ¿EL CACHÉ ES UNA OPTIMIZACIÓN O UNA DEPENDENCIA CRÍTICA?

  Si tu base no puede con el tráfico sin caché, Redis NO es una
  optimización: es parte del camino crítico, y su disponibilidad
  multiplica la tuya (módulo 02). Entonces necesita lo mismo que
  cualquier dependencia crítica:

    - réplicas y failover automático (y saber cuántos segundos tarda)
    - alertas sobre memoria y evicted_keys MUCHO antes del 100%
    - un plan de degradación: rate limiting agresivo o circuit breaker
      que proteja la base sirviendo errores rápidos al 80% del tráfico
      en vez de dejar que se caiga para el 100% (módulo 08)
    - caché local en los pods como segunda línea, aunque sea con TTL
      de 5 segundos

  La respuesta honesta en la mayoría de los sistemas es "es una
  dependencia crítica y nunca lo tratamos como tal".
`);

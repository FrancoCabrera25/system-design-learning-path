/**
 * Módulo 08 — Por qué el backoff sin jitter no sirve de nada.
 *
 *   node modules/08-fiabilidad/jitter.ts
 *
 * 50.000 clientes fallan EN EL MISMO INSTANTE (se cayó la base, se reinició
 * el servicio, se cortó la red). Todos reintentan con backoff exponencial.
 *
 * Sin jitter, "backoff exponencial" significa que todos vuelven juntos — sólo
 * que un poco más tarde. El pico sincronizado es idéntico al original.
 */

const CLIENTES = 50_000;
const CAPACIDAD_SEG = 5_000;        // req/s que el servicio aguanta al volver
const BASE_MS = 500;
const TECHO_MS = 30_000;
const MAX_INTENTOS = 12;
const VENTANA_MS = 100;             // resolución de la medición

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

type Backoff = (intento: number, anterior: number) => number;

const ESTRATEGIAS: [string, Backoff][] = [
  ['sin backoff (reintento ya)', () => 0],
  ['exponencial SIN jitter', (i) => Math.min(TECHO_MS, BASE_MS * 2 ** i)],
  ['equal jitter', (i) => {
    const t = Math.min(TECHO_MS, BASE_MS * 2 ** i);
    return t / 2 + Math.random() * (t / 2);
  }],
  ['FULL jitter (AWS)', (i) => Math.random() * Math.min(TECHO_MS, BASE_MS * 2 ** i)],
  ['decorrelated jitter', (_i, prev) =>
    Math.min(TECHO_MS, BASE_MS + Math.random() * (prev * 3 - BASE_MS))],
];

interface Resultado { picoSeg: number; drenadoS: number; intentosTotales: number; exitosos: number; rendidos: number; }

function simular(backoff: Backoff): Resultado {
  // Cada cliente: cuándo va a reintentar y cuántas veces lleva
  const clientes = Array.from({ length: CLIENTES }, () => ({ t: 0, intento: 0, prev: BASE_MS, ok: false }));
  const porVentana = new Map<number, number>();
  let intentosTotales = 0, exitosos = 0, rendidos = 0;
  let pendientes = CLIENTES;
  let reloj = 0;

  while (pendientes > 0 && reloj < 600_000) {
    // Agrupar los intentos de esta ventana
    const enVentana = clientes.filter((c) => !c.ok && c.t >= reloj && c.t < reloj + VENTANA_MS);
    if (enVentana.length > 0) {
      const v = Math.floor(reloj / VENTANA_MS);
      porVentana.set(v, (porVentana.get(v) ?? 0) + enVentana.length);
      intentosTotales += enVentana.length;

      // El servicio atiende hasta su capacidad en esta ventana; el resto falla
      const capacidadVentana = (CAPACIDAD_SEG * VENTANA_MS) / 1000;
      enVentana.forEach((c, idx) => {
        if (idx < capacidadVentana) { c.ok = true; exitosos++; pendientes--; return; }
        c.intento++;
        if (c.intento >= MAX_INTENTOS) { c.ok = true; rendidos++; pendientes--; return; }
        const espera = backoff(c.intento, c.prev);
        c.prev = Math.max(BASE_MS, espera);
        c.t = reloj + VENTANA_MS + espera;
      });
    }
    reloj += VENTANA_MS;
  }

  // El pico de los REINTENTOS: la ventana 0 es el fallo inicial simultáneo,
  // que es el evento disparador y es igual para todas las estrategias.
  const reintentos = [...porVentana.entries()].filter(([v]) => v > 0).map(([, n]) => n);
  const pico = (reintentos.length ? Math.max(...reintentos) : 0) * (1000 / VENTANA_MS);
  return { picoSeg: pico, drenadoS: reloj / 1000, intentosTotales, exitosos, rendidos };
}

console.log('='.repeat(82));
console.log(`  ${fmt(CLIENTES)} clientes fallan EN EL MISMO INSTANTE · el servicio aguanta ${fmt(CAPACIDAD_SEG)} req/s`);
console.log('='.repeat(82));
console.log('  (la ventana del fallo inicial se excluye: es igual para todos y no depende de la estrategia)');
console.log('\n  estrategia                   pico de REINTENTOS  vs cap.   intentos   se rindieron   drenó en');
console.log('  ' + '-'.repeat(80));

for (const [nombre, fn] of ESTRATEGIAS) {
  const r = simular(fn);
  const veces = r.picoSeg / CAPACIDAD_SEG;
  const pctRendidos = (r.rendidos / CLIENTES) * 100;
  const icono = pctRendidos > 20 ? '💀' : pctRendidos > 2 ? '⚠️ ' : '✅';
  console.log(
    `  ${nombre.padEnd(28)} ${fmt(r.picoSeg).padStart(11)} req/s ${fmt(veces, 1).padStart(6)}x   ` +
      `${fmt(r.intentosTotales).padStart(8)}   ${fmt(pctRendidos, 1).padStart(9)} %   ${fmt(r.drenadoS, 1).padStart(6)} s  ${icono}`,
  );
}

console.log(`
  LO QUE HAY QUE VER

  "EXPONENCIAL SIN JITTER" es la trampa de este script. Suena a que está
  bien hecho —hay backoff, hay exponencial, el código se ve profesional—
  y el pico es idéntico al de no tener backoff. Porque todos los clientes
  fallaron en el mismo milisegundo, así que todos calculan la MISMA espera
  y vuelven todos juntos. El backoff sin jitter no desparrama la carga:
  sólo la mueve un poco más tarde, intacta.

  Es el mismo fenómeno que el TTL sin jitter del módulo 04: ahí eran
  claves de caché expirando juntas, acá son clientes reintentando juntos.
  El problema no es la espera: es la SINCRONIZACIÓN.

  FULL JITTER — espera = random(0, min(techo, base × 2^intento)) — rompe
  la sincronización por completo. Es una línea de código.

  Y mirá las columnas de INTENTOS TOTALES y SE RINDIERON, que son el
  resultado contraintuitivo: el jitter no sólo baja el pico, sino que
  hace que el sistema drene con MUCHO menos trabajo total y con muchos
  menos clientes que se van sin ser atendidos.

  Sin jitter, cada oleada se estrella ENTERA contra la capacidad: se
  atiende la misma fracción chica y el resto rebota, oleada tras oleada,
  hasta agotar sus 12 intentos. Con jitter, cada cliente llega cuando hay
  lugar y sale a la primera o a la segunda.

     Esperar un rato AL AZAR hace que todos terminen antes y con menos
     trabajo. Es el resultado que AWS midió y publicó, y es la razón por
     la que esto no es una optimización menor.

  DECORRELATED JITTER — espera = min(techo, random(base, anterior × 3)) —
  es la variante que AWS recomienda cuando querés que el reintento se
  adapte a cuánto esperaste la vez anterior en lugar de al número de
  intento. Rinde parecido al full jitter.

  LA REGLA: nunca un backoff sin jitter. Y nunca un backoff sin TECHO:
  sin él, 2^12 × 500 ms son 34 minutos y el cliente ya se fue.
`);

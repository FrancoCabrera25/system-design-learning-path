/**
 * Módulo 03 — Por qué existe el consistent hashing.
 *
 *   node modules/03-escalabilidad/consistent-hashing.ts
 *
 * Tres mediciones:
 *   A) Qué porcentaje de claves se remapea al agregar un nodo.
 *   B) Qué pasa con el reparto si NO usás nodos virtuales.
 *   C) Qué significa eso en tráfico real contra la base de datos.
 */

const N_CLAVES = 100_000;
const claves = Array.from({ length: N_CLAVES }, (_, i) => `user:${i}:session`);

/** FNV-1a de 32 bits. Rápido, sin dependencias, suficientemente uniforme. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Estrategia 1 — hash(key) % N, la que se escribe sin pensar
// ---------------------------------------------------------------------------
const porModulo = (clave: string, n: number) => hash(clave) % n;

// ---------------------------------------------------------------------------
// Estrategia 2 — anillo de consistent hashing
// ---------------------------------------------------------------------------
class Anillo {
  /** Puntos del anillo, ordenados por posición: [posición, nombre del nodo] */
  private puntos: [number, string][] = [];
  private vnodos: number;

  // Nota: nada de "parameter properties" (private en el constructor) — Node
  // hace type-stripping puro y esa sintaxis necesita generar código.
  constructor(nodos: string[], vnodos: number) {
    this.vnodos = vnodos;
    for (const n of nodos) this.agregar(n);
  }

  agregar(nodo: string): void {
    for (let v = 0; v < this.vnodos; v++) {
      this.puntos.push([hash(`${nodo}#${v}`), nodo]);
    }
    this.puntos.sort((a, b) => a[0] - b[0]);
  }

  /** Primer punto >= hash(clave), girando en sentido horario. */
  buscar(clave: string): string {
    const h = hash(clave);
    let lo = 0, hi = this.puntos.length - 1;
    if (h > this.puntos[hi][0]) return this.puntos[0][1];   // da la vuelta
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.puntos[mid][0] < h) lo = mid + 1; else hi = mid;
    }
    return this.puntos[lo][1];
  }
}

// ---------------------------------------------------------------------------
// A) Remapeo al agregar un nodo
// ---------------------------------------------------------------------------
console.log('='.repeat(74));
console.log(`  A) ¿CUÁNTAS CLAVES CAMBIAN DE NODO AL AGREGAR UNO? (${N_CLAVES.toLocaleString('es-AR')} claves)`);
console.log('='.repeat(74));
console.log('\n   nodos        hash % N        anillo (150 vnodos)      ideal');
console.log('  ' + '-'.repeat(64));

for (const n of [4, 8, 16, 32]) {
  // por módulo
  let movidasMod = 0;
  for (const c of claves) if (porModulo(c, n) !== porModulo(c, n + 1)) movidasMod++;

  // por anillo
  const nodos = Array.from({ length: n }, (_, i) => `nodo-${i}`);
  const antes = new Anillo(nodos, 150);
  const despues = new Anillo([...nodos, `nodo-${n}`], 150);
  let movidasAnillo = 0;
  for (const c of claves) if (antes.buscar(c) !== despues.buscar(c)) movidasAnillo++;

  const ideal = (1 / (n + 1)) * 100;
  console.log(
    `  ${String(n).padStart(3)} -> ${String(n + 1).padEnd(4)}  ` +
      `${((movidasMod / N_CLAVES) * 100).toFixed(1).padStart(8)} %  ` +
      `${((movidasAnillo / N_CLAVES) * 100).toFixed(1).padStart(16)} %  ` +
      `${ideal.toFixed(1).padStart(12)} %`,
  );
}

console.log(`
  El "ideal" es 1/(N+1): lo mínimo que se PUEDE mover, porque el nodo nuevo
  tiene que quedarse con su parte. El anillo se le pega casi exacto.
  El módulo mueve entre el 75% y el 97% de las claves.`);

// ---------------------------------------------------------------------------
// B) Nodos virtuales
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(74)}`);
console.log('  B) POR QUÉ LOS NODOS VIRTUALES NO SON OPCIONALES (8 nodos reales)');
console.log('='.repeat(74));
console.log('\n   vnodos por nodo    nodo más cargado    nodo menos cargado    desbalance');
console.log('  ' + '-'.repeat(70));

const ochoNodos = Array.from({ length: 8 }, (_, i) => `nodo-${i}`);
for (const v of [1, 5, 20, 150, 500]) {
  const anillo = new Anillo(ochoNodos, v);
  const cuenta = new Map<string, number>(ochoNodos.map((n) => [n, 0]));
  for (const c of claves) cuenta.set(anillo.buscar(c), cuenta.get(anillo.buscar(c))! + 1);
  const vals = [...cuenta.values()];
  const max = Math.max(...vals), min = Math.min(...vals);
  const esperado = N_CLAVES / 8;
  console.log(
    `  ${String(v).padStart(12)}       ${((max / esperado) * 100).toFixed(0).padStart(6)} %` +
      `           ${((min / esperado) * 100).toFixed(0).padStart(6)} %` +
      `           ${(max / min).toFixed(2).padStart(8)}x`,
  );
}

console.log(`
  Con 1 vnodo por nodo el anillo queda lleno de huecos desparejos: el nodo
  más cargado recibe casi 12 veces lo del menos cargado. Uno se satura
  mientras otro está ocioso, y ninguna métrica promedio te lo muestra.

  Cada vnodo que agregás es una muestra más de la ley de los grandes
  números: 150 vnodos bajan el desbalance a ~1,9x y 500 a ~1,5x. La
  tendencia es el punto. (Acá usamos FNV-1a, que es rápido pero no
  ideal para esto; las implementaciones reales usan murmur3 o MD5 y
  llegan más cerca del reparto perfecto con los mismos ~150 vnodos.)

  El costo de los vnodos es memoria y un lookup un poco más caro:
  N x 150 entradas ordenadas en vez de N. Es baratísimo comparado con
  tener un nodo al 250% de carga.`);

// ---------------------------------------------------------------------------
// C) Qué significa en tráfico real
// ---------------------------------------------------------------------------
const QPS = 50_000;
const HIT_RATE = 0.95;

console.log(`\n${'='.repeat(74)}`);
console.log('  C) QUÉ SIGNIFICA ESTO UN MARTES A LAS 3 DE LA TARDE');
console.log('='.repeat(74));

let movidas4a5 = 0;
for (const c of claves) if (porModulo(c, 4) !== porModulo(c, 5)) movidas4a5++;
const pctMod = movidas4a5 / N_CLAVES;

const cuatro = Array.from({ length: 4 }, (_, i) => `nodo-${i}`);
const anillo4 = new Anillo(cuatro, 150);
const anillo5 = new Anillo([...cuatro, 'nodo-4'], 150);
let movidasAnillo4a5 = 0;
for (const c of claves) if (anillo4.buscar(c) !== anillo5.buscar(c)) movidasAnillo4a5++;
const pctAnillo = movidasAnillo4a5 / N_CLAVES;

console.log(`
  Cluster de caché de 4 nodos, ${QPS.toLocaleString('es-AR')} req/s, ${HIT_RATE * 100}% de hit rate.
  Normalmente la base recibe ${(QPS * (1 - HIT_RATE)).toLocaleString('es-AR')} req/s (los misses).

  Agregás un 5º nodo porque te estabas quedando sin memoria:

    con hash % N   -> ${(pctMod * 100).toFixed(0)} % de las claves cambian de nodo
                      la base pasa de ${(QPS * (1 - HIT_RATE)).toLocaleString('es-AR')} a ${Math.round(QPS * pctMod).toLocaleString('es-AR')} req/s
                      = ${(((QPS * pctMod) / (QPS * (1 - HIT_RATE)))).toFixed(0)}x el tráfico normal, DE GOLPE

    con anillo     -> ${(pctAnillo * 100).toFixed(0)} % de las claves cambian de nodo
                      la base pasa a ${Math.round(QPS * pctAnillo).toLocaleString('es-AR')} req/s
                      = ${((QPS * pctAnillo) / (QPS * (1 - HIT_RATE))).toFixed(0)}x — mucho mejor, pero NO gratis

  El primer caso es el incidente clásico: intentás ampliar el caché para
  aguantar más carga, y la ampliación misma te tira abajo la base. Peor
  todavía, suele pasar al revés — un nodo de caché SE CAE, N pasa de 4 a 3
  sin que nadie decida nada, y el sistema se lleva puesto solo.

  Y ojo: el anillo reduce el remapeo, NO lo elimina. Ese 3x de golpe
  contra la base sigue siendo un pico que hay que aguantar. Por eso
  esto se combina con las defensas del módulo 04 (TTL con jitter,
  single-flight, caché en dos niveles) y con agregar nodos DE A UNO.
`);

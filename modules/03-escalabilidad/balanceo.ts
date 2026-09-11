/**
 * Módulo 03 — Algoritmos de load balancing sobre servidores desiguales.
 *
 *   node modules/03-escalabilidad/balanceo.ts
 *
 * 20 servidores, pero NO son iguales: en cualquier flota real hay pods recién
 * arrancados con el JIT frío, pods con un vecino ruidoso en el mismo nodo, y
 * pods con una pausa de GC. Acá 3 de los 20 son 5x más lentos.
 *
 * Round robin asume que todos son iguales. Los otros algoritmos lo miden.
 */

const N_SERVIDORES = 20;
const N_REQUESTS = 200_000;
const SERVICIO_BASE_MS = 20;
const UTILIZACION_OBJETIVO = 0.7;   // la flota en conjunto, al 70%

/** 3 de 20 servidores son 5x más lentos. El resto varía un poco entre sí. */
const VELOCIDAD = Array.from({ length: N_SERVIDORES }, (_, i) =>
  i < 3 ? 5.0 : 0.9 + Math.random() * 0.2,
);

const exponencial = (media: number) => -Math.log(1 - Math.random()) * media;

function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

type Algoritmo = (activos: number[], i: number) => number;

const ALGORITMOS: Record<string, Algoritmo> = {
  'round robin': (_a, i) => i % N_SERVIDORES,

  'random': () => Math.floor(Math.random() * N_SERVIDORES),

  /** Power of two choices: mirá SÓLO DOS al azar y elegí el mejor. */
  'power of 2': (activos) => {
    const a = Math.floor(Math.random() * N_SERVIDORES);
    let b = Math.floor(Math.random() * N_SERVIDORES);
    while (b === a) b = Math.floor(Math.random() * N_SERVIDORES);
    return activos[a] <= activos[b] ? a : b;
  },

  /** Least connections: mirá TODOS y elegí el que menos requests activas tiene. */
  'least conn': (activos) => {
    let mejor = 0;
    for (let s = 1; s < N_SERVIDORES; s++) if (activos[s] < activos[mejor]) mejor = s;
    return mejor;
  },
};

interface Resultado { latencias: number[]; carga: number[]; }

function simular(elegir: Algoritmo): Resultado {
  // Capacidad total de la flota, en req/s, considerando las velocidades
  const capacidad = VELOCIDAD.reduce((a, v) => a + 1000 / (SERVICIO_BASE_MS * v), 0);
  const intervaloLlegadas = 1000 / (capacidad * UTILIZACION_OBJETIVO);

  const pendientes: number[][] = Array.from({ length: N_SERVIDORES }, () => []);
  const libreEn = new Array(N_SERVIDORES).fill(0);
  const carga = new Array(N_SERVIDORES).fill(0);
  const latencias: number[] = [];

  let reloj = 0;
  for (let i = 0; i < N_REQUESTS; i++) {
    reloj += exponencial(intervaloLlegadas);

    // Purgar las que ya terminaron: lo que queda son las requests "activas",
    // que es justamente lo que un balanceador L7 puede contar.
    const activos = new Array(N_SERVIDORES);
    for (let s = 0; s < N_SERVIDORES; s++) {
      const p = pendientes[s];
      while (p.length && p[0] <= reloj) p.shift();
      activos[s] = p.length;
    }

    const s = elegir(activos, i);
    const empieza = Math.max(reloj, libreEn[s]);
    const servicio = exponencial(SERVICIO_BASE_MS * VELOCIDAD[s]);
    libreEn[s] = empieza + servicio;
    pendientes[s].push(libreEn[s]);
    carga[s]++;
    latencias.push(libreEn[s] - reloj);
  }

  return { latencias, carga };
}

console.log('='.repeat(76));
console.log(`  ${N_SERVIDORES} servidores, flota al ${UTILIZACION_OBJETIVO * 100}% de utilización, ${N_REQUESTS.toLocaleString('es-AR')} requests`);
console.log('='.repeat(76));
console.log(`  Servidores 0, 1 y 2 son 5x MÁS LENTOS (pod frío / vecino ruidoso / GC).`);
console.log(`  Los otros 17 varían entre 0,9x y 1,1x.\n`);
console.log('  algoritmo        p50        p99      p99.9     req al lento    veredicto');
console.log('  ' + '-'.repeat(72));

for (const [nombre, fn] of Object.entries(ALGORITMOS)) {
  const { latencias, carga } = simular(fn);
  const alLento = ((carga[0] + carga[1] + carga[2]) / N_REQUESTS) * 100;
  const p99 = percentil(latencias, 99);
  const veredicto =
    p99 > 2000 ? '💀 inservible' : p99 > 500 ? '⚠️  degradado' : '✅ sano';
  console.log(
    `  ${nombre.padEnd(14)} ${percentil(latencias, 50).toFixed(0).padStart(6)} ms ` +
      `${p99.toFixed(0).padStart(8)} ms ${percentil(latencias, 99.9).toFixed(0).padStart(8)} ms ` +
      `${alLento.toFixed(1).padStart(10)} %      ${veredicto}`,
  );
}

console.log(`
  CÓMO LEER ESTO

  "req al lento" es qué porcentaje del tráfico terminó en los 3 servidores
  lentos. El reparto "justo" sería 15% (3 de 20). Pero esos 3 tardan 5x, así
  que mandarles el 15% del tráfico es exactamente lo que NO hay que hacer:
  van a ser el cuello de botella de todo el sistema.

   - ROUND ROBIN les manda su 15% religiosamente. Hagamos la cuenta:
     llegan ~616 req/s, repartidas en 20 partes iguales son ~31 req/s por
     servidor. Pero un servidor lento sólo puede con 10 req/s. Su
     utilización es 3,1 — o sea MAYOR A 1 — y por lo tanto su cola NO se
     estabiliza en un valor alto: crece para siempre (módulo 01, sección 5).
     Ese p99 de varios minutos no es un error de la simulación: es la cola
     infinita, y en producción se ve como timeouts masivos en el 15% del
     tráfico mientras los otros 17 servidores están medio ociosos.
     Round robin no está balanceando: está repartiendo parejo, que no es
     lo mismo.

   - RANDOM hace lo mismo en promedio. Aleatorio no es adaptativo.

   - POWER OF 2 mira sólo DOS servidores al azar y elige el menos cargado.
     Con esa información mínima, el tráfico se desvía casi por completo de
     los lentos. No necesita estado global, no necesita coordinación: dos
     muestras al azar alcanzan.

   - LEAST CONNECTIONS es el óptimo teórico, pero necesita que el
     balanceador conozca el estado de los N servidores en todo momento.
     Con muchos balanceadores en paralelo eso es caro (y se desincroniza).

  LA MORALEJA, que es un resultado clásico de teoría de colas:
  pasar de "elegir 1 al azar" a "elegir el mejor de 2 al azar" reduce el
  desbalance máximo de O(log n) a O(log log n). Es una de las mejores
  relaciones costo/beneficio que existen en sistemas distribuidos, y por
  eso está implementado en Envoy, NGINX, HAProxy y casi todo service mesh.

  EN UNA ENTREVISTA: cuando alguien dice "uso round robin", la repregunta
  correcta es "¿y si un backend está degradado pero vivo?". Un servidor
  lento pasa el health check y round robin le sigue mandando su cuota.
  El health check dice "vivo/muerto"; el balanceo necesita saber "rápido/
  lento". Son dos señales distintas.
`);

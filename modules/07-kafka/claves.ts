/**
 * Módulo 07 — La clave decide la partición, y por lo tanto el orden Y el lag.
 *
 *   node modules/07-kafka/claves.ts
 *
 * Mismo topic, mismo tráfico, mismos consumidores. Lo único que cambia es qué
 * se usa como `key`. El resultado va de "todo sano" a "una partición con lag
 * infinito mientras 11 consumidores están medio ociosos".
 */

const PARTICIONES = 12;
const MENSAJES = 500_000;
const LLEGADAS_MSG_SEG = 1_000;
const MS_POR_MENSAJE = 10;
const POR_CONSUMIDOR = 1000 / MS_POR_MENSAJE;   // 100 msg/s por partición

const N_TENANTS = 500;
const SHARE_MEGA_TENANT = 0.40;    // un tenant enorme: el 40% del tráfico

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

/** FNV-1a. Kafka usa murmur2; la conclusión no cambia. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// El tráfico: un mega-tenant + una cola Zipf de tenants chicos
// ---------------------------------------------------------------------------
const pesos = Array.from({ length: N_TENANTS - 1 }, (_, i) => 1 / Math.pow(i + 1, 1.1));
const total = pesos.reduce((a, b) => a + b, 0);
const acum: number[] = [];
let acc = 0;
for (const p of pesos) { acc += p / total; acum.push(acc); }

function tenantDelMensaje(): number {
  if (Math.random() < SHARE_MEGA_TENANT) return 0;      // el mega-tenant
  const r = Math.random();
  let lo = 0, hi = acum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (acum[m] < r) lo = m + 1; else hi = m; }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Las cuatro estrategias de clave
// ---------------------------------------------------------------------------
type Estrategia = {
  nombre: string;
  particion: (tenant: number, orden: number, i: number, nParts: number) => number;
  orden: string;
};

const ESTRATEGIAS: Estrategia[] = [
  {
    nombre: 'key = null (round robin)',
    particion: (_t, _o, i, n) => i % n,
    orden: '❌ NINGUNO: order.updated puede llegar antes que order.created',
  },
  {
    nombre: 'key = tenantId',
    particion: (t, _o, _i, n) => hash(`t${t}`) % n,
    orden: '✅ por tenant (y por lo tanto por orden, que es un subconjunto)',
  },
  {
    nombre: 'key = orderId',
    particion: (_t, o, _i, n) => hash(`o${o}`) % n,
    orden: '✅ por orden — el que el negocio realmente necesita',
  },
  {
    nombre: 'key = tenantId:orderId',
    particion: (t, o, _i, n) => hash(`t${t}:o${o}`) % n,
    orden: '✅ por orden. Igual que orderId, con la clave más explícita',
  },
];

function simular(e: Estrategia, nParts: number): number[] {
  const porParticion = new Array(nParts).fill(0);
  for (let i = 0; i < MENSAJES; i++) {
    const t = tenantDelMensaje();
    const orden = Math.floor(Math.random() * 1_000_000);   // muchas órdenes distintas
    porParticion[e.particion(t, orden, i, nParts)]++;
  }
  return porParticion;
}

// ---------------------------------------------------------------------------
// A) Reparto y lag con 12 particiones
// ---------------------------------------------------------------------------
console.log('='.repeat(84));
console.log(`  ${PARTICIONES} particiones · ${fmt(LLEGADAS_MSG_SEG)} msg/s · ${fmt(POR_CONSUMIDOR)} msg/s por consumidor`);
console.log('='.repeat(84));
console.log(`  Capacidad total del grupo: ${fmt(PARTICIONES * POR_CONSUMIDOR)} msg/s. Entra ${fmt(LLEGADAS_MSG_SEG)}. Sobra capacidad... en teoría.`);
console.log(`  Un tenant concentra el ${(SHARE_MEGA_TENANT * 100).toFixed(0)}% del tráfico; el resto se reparte entre ${N_TENANTS - 1}.\n`);
console.log('  estrategia                   part. más cargada   su carga real   ¿aguanta?   lag tras 1 h');
console.log('  ' + '-'.repeat(82));

for (const e of ESTRATEGIAS) {
  const dist = simular(e, PARTICIONES);
  const max = Math.max(...dist);
  const sharePeor = max / MENSAJES;
  const msgSegPeor = LLEGADAS_MSG_SEG * sharePeor;
  const aguanta = msgSegPeor <= POR_CONSUMIDOR;
  const lagHora = aguanta ? 0 : (msgSegPeor - POR_CONSUMIDOR) * 3600;

  console.log(
    `  ${e.nombre.padEnd(28)} ${(sharePeor * 100).toFixed(1).padStart(16)} %   ` +
      `${fmt(msgSegPeor).padStart(10)} msg/s   ${(aguanta ? '✅ sí' : '💀 NO').padEnd(9)}   ${fmt(lagHora).padStart(11)}`,
  );
}

console.log('\n  qué orden te da cada una:');
console.log('  ' + '-'.repeat(82));
for (const e of ESTRATEGIAS) console.log(`  ${e.nombre.padEnd(28)} ${e.orden}`);

// ---------------------------------------------------------------------------
// B) ¿Y si agrego particiones?
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(84)}`);
console.log('  B) "AGREGUEMOS PARTICIONES" — con key = tenantId');
console.log('='.repeat(84));
console.log('\n  particiones   part. más cargada   su carga   ¿aguanta?   capacidad total del grupo');
console.log('  ' + '-'.repeat(82));

const porTenant = ESTRATEGIAS[1];
for (const n of [12, 24, 48, 96, 200]) {
  const dist = simular(porTenant, n);
  const share = Math.max(...dist) / MENSAJES;
  const msgSeg = LLEGADAS_MSG_SEG * share;
  const aguanta = msgSeg <= POR_CONSUMIDOR;
  console.log(
    `  ${String(n).padStart(11)}   ${(share * 100).toFixed(1).padStart(16)} %   ` +
      `${fmt(msgSeg).padStart(7)} msg/s   ${(aguanta ? '✅ sí' : '💀 NO').padEnd(9)}   ${fmt(n * POR_CONSUMIDOR)} msg/s`,
  );
}

console.log(`
  ACÁ ESTÁ EL RESULTADO IMPORTANTE DEL SCRIPT.

  Pasar de 12 a 200 particiones multiplica por 17 la capacidad del grupo...
  y la partición caliente sigue recibiendo el ${(SHARE_MEGA_TENANT * 100).toFixed(0)}% del tráfico. Porque
  murmur2("t0") % 200 sigue dando UN número. El mega-tenant sigue entrando
  por una sola puerta.

     AGREGAR PARTICIONES NO ARREGLA UNA PARTICIÓN CALIENTE. NUNCA.
     Lo único que arregla una partición caliente es CAMBIAR LA CLAVE.

  Y mirá lo perverso del diagnóstico: el lag TOTAL del grupo parece casi
  sano (una partición con lag creciente entre 199 vacías se diluye en el
  promedio), la CPU de los pods está baja, y hay capacidad de sobra.
  La única métrica que lo muestra es EL LAG POR PARTICIÓN.

  POR ESO LA REGLA ES: usá la granularidad más fina que preserve el orden
  que el negocio necesita.

     ¿Necesitás orden entre dos órdenes distintas del mismo tenant?
     Casi nunca. Entonces la clave es orderId, no tenantId.

  El orden por tenant parece "más seguro" y es exactamente lo que te mete
  el problema: una clave más gruesa te da un orden que no usás y una
  partición caliente que sí sufrís.

  SI DE VERDAD NECESITÁS ORDEN POR TENANT y el tenant es enorme:
   - Clave compuesta con sub-partición: 'tenantId:bucket' con N buckets
     por tenant. Te da orden DENTRO del bucket y reparte la carga. Hay
     que elegir el bucket de forma estable (hash de la entidad, no random).
   - Topic dedicado para el mega-tenant, con sus propias particiones y
     consumidores. Feo, aislado, y funciona.
`);

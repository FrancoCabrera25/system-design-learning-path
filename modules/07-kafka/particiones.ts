/**
 * Módulo 07 — La partición es la unidad de paralelismo, no el pod.
 *
 *   node modules/07-kafka/particiones.ts
 *
 * Resuelve numéricamente el C3 del módulo 03: "escalé el consumer de 3 a 12
 * réplicas y el lag no bajó en absoluto". Spoiler: 9 pods no reciben nada.
 */

const LLEGADAS_MSG_SEG = 1_200;    // lo que produce el topic
const MS_POR_MENSAJE = 80;         // lo que tarda el handler (una query + una API)

/** Throughput de UN consumidor procesando de a un mensaje por vez. */
const POR_CONSUMIDOR = 1000 / MS_POR_MENSAJE;

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log('='.repeat(82));
console.log(`  ${fmt(LLEGADAS_MSG_SEG)} msg/s entrando · ${MS_POR_MENSAJE} ms por mensaje · ${fmt(POR_CONSUMIDOR, 1)} msg/s por consumidor`);
console.log('='.repeat(82));
console.log('\n  particiones   consumidores   ACTIVOS   IDLE   throughput   ¿alcanza?   lag tras 1 hora');
console.log('  ' + '-'.repeat(80));

const CASOS: [number, number][] = [
  [6, 3], [6, 6], [6, 12], [6, 50],
  [24, 24], [48, 48], [96, 96], [96, 120], [200, 96],
];

for (const [particiones, consumidores] of CASOS) {
  // LA REGLA: cada partición la consume UN consumidor. El resto queda idle.
  const activos = Math.min(particiones, consumidores);
  const idle = Math.max(0, consumidores - particiones);
  const throughput = activos * POR_CONSUMIDOR;
  const alcanza = throughput >= LLEGADAS_MSG_SEG;
  const lagHora = alcanza ? 0 : (LLEGADAS_MSG_SEG - throughput) * 3600;

  const marca = alcanza ? '✅ sí   ' : '💀 NO   ';
  const notaIdle = idle > 0 ? `  <-- ${idle} pods sin hacer nada` : '';
  console.log(
    `  ${String(particiones).padStart(11)}   ${String(consumidores).padStart(12)}   ` +
      `${String(activos).padStart(7)}   ${String(idle).padStart(4)}   ` +
      `${fmt(throughput).padStart(10)}   ${marca}   ${fmt(lagHora).padStart(14)}${notaIdle}`,
  );
}

const minimo = Math.ceil(LLEGADAS_MSG_SEG / POR_CONSUMIDOR);

console.log(`
  LA CUENTA, QUE ES DIRECTA

     particiones necesarias = throughput pico / throughput por consumidor
                            = ${fmt(LLEGADAS_MSG_SEG)} / ${fmt(POR_CONSUMIDOR, 1)}
                            = ${minimo} PARTICIONES

  Con 6 particiones el techo del grupo entero es ${fmt(6 * POR_CONSUMIDOR)} msg/s contra ${fmt(LLEGADAS_MSG_SEG)}
  que entran. El lag no "crece despacio": crece ${fmt(LLEGADAS_MSG_SEG - 6 * POR_CONSUMIDOR)} mensajes por segundo,
  para siempre, sin importar cuántos pods agregues.

  Y FIJATE EN LA FILA DE 6 PARTICIONES CON 50 CONSUMIDORES:
  44 pods vivos, sanos, pasando los health checks, consumiendo CPU y memoria
  y RAM del cluster — sin recibir un solo mensaje. El throughput es idéntico
  al de 6 pods.

  LA TRAMPA DEL AUTOESCALADO (y por qué el HPA empeora las cosas)

  Los pods idle no usan CPU. Entonces el PROMEDIO de CPU del deployment baja
  al agregarlos... así que el HPA escala MÁS. Cada pod nuevo baja más el
  promedio. Terminás con 50 pods, el mismo throughput que con 6, y un HPA
  convencido de que está haciendo su trabajo.

  Es el mismo patrón que el gRPC con balanceo L4 del módulo 02: la métrica
  dice que escalaste, la realidad dice que no.

  QUÉ HACER CUANDO 6 PARTICIONES YA ESTÁN EN PRODUCCIÓN`);

// ---------------------------------------------------------------------------
// Las opciones reales, con sus costos
// ---------------------------------------------------------------------------
const OPCIONES: [string, number, number, string][] = [
  // [nombre, particiones efectivas, concurrencia por consumidor, costo]
  ['dejar 6 particiones', 6, 1, '—'],
  ['subir a 96 particiones', 96, 1, 'cambia key→partición: rompe el orden de lo en vuelo'],
  ['6 part. + concurrencia 16', 6, 16, 'PIERDE el orden dentro de la partición'],
  ['bajar a 20 ms por mensaje', 6, 1, 'batchear escrituras, sacar una llamada del handler'],
];

console.log('\n  opción                        throughput   ¿alcanza?   el costo');
console.log('  ' + '-'.repeat(80));
for (const [nombre, parts, conc, costo] of OPCIONES) {
  const ms = nombre.includes('20 ms') ? 20 : MS_POR_MENSAJE;
  const th = Math.min(parts, 96) * conc * (1000 / ms);
  console.log(
    `  ${nombre.padEnd(29)} ${fmt(th).padStart(10)}   ${(th >= LLEGADAS_MSG_SEG ? '✅ sí' : '💀 NO').padEnd(9)}   ${costo}`,
  );
}

console.log(`
  LAS TRES PALANCAS, Y CUÁL ELEGIR

  1. MÁS PARTICIONES. La solución natural, y tiene letra chica:
     las particiones se pueden AUMENTAR pero NUNCA REDUCIR, y aumentarlas
     cambia el mapeo murmur2(key) % N — así que una clave que iba a la
     partición 3 ahora va a la 47, y durante la transición el orden por
     clave entre lo viejo y lo nuevo NO está garantizado. Si tu consumidor
     depende del orden, hay que planificarlo (drenar, o tolerar el desorden).

  2. CONCURRENCIA DENTRO DEL CONSUMIDOR. Traer el batch de una partición y
     procesarlo en paralelo. Costo alto: perdés el orden dentro de la
     partición Y el manejo de offsets se complica — no podés commitear el
     offset N hasta que TODO lo anterior terminó, o perdés mensajes en el
     próximo rebalance. Sólo si el procesamiento es idempotente y sin
     orden (módulo 06).

  3. BAJAR LOS 80 ms. Casi siempre la más barata y la que nadie prueba
     primero: batchear las escrituras a la base, sacar una llamada HTTP
     sincrónica del handler, cachear algo. Pasar de 80 a 20 ms cuadruplica
     el throughput SIN tocar la topología ni perder garantías.

  Y LA REGLA PARA EL DÍA 1: dimensioná las particiones para 2-3x tu pico
  proyectado. Son baratas al principio y carísimas de cambiar después —
  igual que la clave de partición del módulo 03.
`);

/**
 * Módulo 07 — Lo que cuesta un rebalance, y el loop del que no se sale.
 *
 *   node modules/07-kafka/rebalance.ts
 *
 * Dos cosas distintas:
 *   A) Lo que un rebalance te cuesta en mensajes no consumidos — eager vs
 *      cooperative sticky, y el efecto de static membership en los deploys.
 *   B) El loop de rebalances: cuando procesar el batch tarda más que
 *      max.poll.interval.ms, el grupo expulsa al consumidor, otro reprocesa
 *      lo mismo, tarda lo mismo, y el lag crece para siempre.
 */

const PARTICIONES = 96;
const CONSUMIDORES = 24;
const LLEGADAS_MSG_SEG = 1_200;
const MS_POR_MENSAJE = 80;
const POR_CONSUMIDOR = (1000 / MS_POR_MENSAJE) * (PARTICIONES / CONSUMIDORES);

const DEPLOYS_POR_DIA = 5;
const OTROS_EVENTOS_POR_DIA = 7;   // autoscaling, pods reciclados, red, OOM
const SEG_POR_REBALANCE = 4;       // lo que tarda la reasignación

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// A) El costo de los rebalances
// ---------------------------------------------------------------------------
console.log('='.repeat(84));
console.log(`  A) EL COSTO DE LOS REBALANCES — ${PARTICIONES} particiones, ${CONSUMIDORES} consumidores, ${fmt(LLEGADAS_MSG_SEG)} msg/s`);
console.log('='.repeat(84));

interface Protocolo {
  nombre: string;
  /** Qué fracción del grupo deja de consumir durante el rebalance. */
  fraccionDetenida: number;
  /** Cuántos rebalances se disparan por día. */
  rebalancesPorDia: number;
  nota: string;
}

const PROTOCOLOS: Protocolo[] = [
  {
    nombre: 'eager (viejo)',
    fraccionDetenida: 1.0,
    rebalancesPorDia: DEPLOYS_POR_DIA * CONSUMIDORES + OTROS_EVENTOS_POR_DIA,
    nota: 'todos devuelven todo: stop-the-world. Y un rolling deploy dispara UNO POR POD',
  },
  {
    nombre: 'cooperative sticky',
    fraccionDetenida: 1 / CONSUMIDORES,
    rebalancesPorDia: DEPLOYS_POR_DIA * CONSUMIDORES + OTROS_EVENTOS_POR_DIA,
    nota: 'sólo se mueven las particiones que hace falta mover; el resto sigue',
  },
  {
    nombre: 'cooperative + static membership',
    fraccionDetenida: 1 / CONSUMIDORES,
    rebalancesPorDia: OTROS_EVENTOS_POR_DIA,
    nota: 'group.instance.id: un reinicio dentro de session.timeout NO rebalancea',
  },
];

console.log('\n  protocolo                        rebalances/día   msg sin consumir/día   lag pico');
console.log('  ' + '-'.repeat(82));

for (const p of PROTOCOLOS) {
  const segDetenidos = p.rebalancesPorDia * SEG_POR_REBALANCE * p.fraccionDetenida;
  const msgNoConsumidos = segDetenidos * LLEGADAS_MSG_SEG;
  const lagPico = SEG_POR_REBALANCE * LLEGADAS_MSG_SEG * p.fraccionDetenida;
  const icono = msgNoConsumidos > 100_000 ? '💀' : msgNoConsumidos > 10_000 ? '⚠️ ' : '✅';
  console.log(
    `  ${p.nombre.padEnd(32)} ${String(p.rebalancesPorDia).padStart(14)}   ` +
      `${fmt(msgNoConsumidos).padStart(20)}   ${fmt(lagPico).padStart(8)}  ${icono}`,
  );
}

console.log('\n  ' + '-'.repeat(82));
for (const p of PROTOCOLOS) console.log(`  ${p.nombre.padEnd(32)} ${p.nota}`);

console.log(`
  LO QUE HAY QUE VER

  Con EAGER, un rolling deploy de ${CONSUMIDORES} pods dispara ${CONSUMIDORES} rebalances —uno por
  pod que entra y sale— y en cada uno **el grupo entero deja de consumir**.
  ${fmt(DEPLOYS_POR_DIA)} deploys por día son ${fmt(DEPLOYS_POR_DIA * CONSUMIDORES)} paradas completas. El lag sube en escalera
  cada vez que alguien aprieta "deploy".

  COOPERATIVE STICKY es un cambio de UNA LÍNEA:

      partitionAssigners: [PartitionAssigners.cooperativeSticky]   // kafkajs
      partition.assignment.strategy=CooperativeStickyAssignor      // java

  y baja el costo por el factor del número de consumidores, porque los que
  no pierden particiones siguen trabajando durante la reasignación.

  STATIC MEMBERSHIP (group.instance.id) ataca el otro lado: que el reinicio
  NO cuente como salida del grupo. Si el pod vuelve dentro de
  session.timeout.ms, retoma SUS particiones y no hay rebalance. Para un
  StatefulSet que se reinicia en cada deploy, elimina la causa principal.

  Las dos cosas son configuración, no arquitectura. Y juntas convierten
  ${fmt(PROTOCOLOS[0].rebalancesPorDia * SEG_POR_REBALANCE * LLEGADAS_MSG_SEG)} mensajes/día de parada en ${fmt(PROTOCOLOS[2].rebalancesPorDia * SEG_POR_REBALANCE * LLEGADAS_MSG_SEG / CONSUMIDORES)}.`);

// ---------------------------------------------------------------------------
// B) El loop de rebalances
// ---------------------------------------------------------------------------
const MAX_POLL_INTERVAL_MS = 300_000;   // 5 min, el default

console.log(`\n${'='.repeat(84)}`);
console.log('  B) EL LOOP DE REBALANCES — cuando el batch tarda más que max.poll.interval.ms');
console.log('='.repeat(84));
console.log(`\n  max.poll.interval.ms = ${fmt(MAX_POLL_INTERVAL_MS / 1000)} s (default) · ${MS_POR_MENSAJE} ms por mensaje\n`);
console.log('  max.poll.records   tiempo del batch   ¿llega a poll()?   progreso real   qué pasa');
console.log('  ' + '-'.repeat(82));

for (const maxPollRecords of [100, 500, 2_000, 5_000, 10_000]) {
  const msBatch = maxPollRecords * MS_POR_MENSAJE;
  const llega = msBatch < MAX_POLL_INTERVAL_MS;
  const progreso = llega ? `${fmt(maxPollRecords)} msg` : '0 msg';
  const qué = llega
    ? `avanza ${fmt((maxPollRecords / msBatch) * 1000, 1)} msg/s por consumidor`
    : '💀 EXPULSADO antes de terminar -> reprocesa -> expulsado -> ...';
  console.log(
    `  ${String(maxPollRecords).padStart(16)}   ${fmt(msBatch / 1000, 1).padStart(14)} s   ` +
      `${(llega ? '✅ sí' : '❌ NO').padEnd(16)}   ${progreso.padStart(13)}   ${qué}`,
  );
}

console.log(`
  EL MECANISMO, PASO POR PASO

   1. El consumidor hace poll() y se trae ${fmt(10_000)} registros.
   2. Tarda ${fmt((10_000 * MS_POR_MENSAJE) / 1000 / 60, 1)} minutos en procesarlos. Los heartbeats SIGUEN saliendo
      (van en un hilo aparte), así que para session.timeout.ms está vivo.
   3. Pero no vuelve a llamar a poll() en ${fmt(MAX_POLL_INTERVAL_MS / 1000)} s -> el coordinador lo
      declara muerto y rebalancea.
   4. Otro consumidor toma la partición DESDE EL ÚLTIMO OFFSET COMMITEADO
      (que no avanzó, porque el batch nunca terminó).
   5. Trae los mismos ${fmt(10_000)} registros, tarda lo mismo, lo expulsan igual.
   6. Volver a 3. PARA SIEMPRE.

  El progreso real es CERO. El lag crece a ${fmt(LLEGADAS_MSG_SEG)} msg/s y el grupo está
  permanentemente rebalanceando. Y lo que se ve desde afuera es: los pods
  están vivos, consumen CPU, los logs muestran actividad... y el lag sube
  en línea recta.

  Es el mismo fallo metaestable del módulo 01: el sistema no sale solo del
  estado malo, porque el reproceso alimenta la causa.

  CÓMO SALIR Y CÓMO PREVENIRLO

   1. BAJAR max.poll.records. El arreglo inmediato y el más seguro: el
      batch tiene que terminar MUY por debajo de max.poll.interval.ms.
      Regla práctica: que el peor batch tarde menos del 25% del intervalo.
   2. SUBIR max.poll.interval.ms. Sirve, y es el que hay que usar con
      cuidado: si el consumidor de verdad se cuelga, el grupo tarda todo
      ese tiempo en darse cuenta.
   3. HACER EL HANDLER MÁS RÁPIDO (otra vez: batchear, sacar llamadas
      sincrónicas). Ataca la causa en vez del síntoma.
   4. COMMITS MANUALES más frecuentes: así, aunque te expulsen, el
      reproceso es chico en vez de ser el batch entero.
   5. ALERTAR SOBRE LA TASA DE REBALANCES del grupo, no sólo sobre el lag.
      Un grupo que rebalancea cada 5 minutos está roto, aunque el lag
      todavía no se note. Es la métrica que avisa temprano.

  Y el recordatorio del módulo 06: cada vuelta de este loop reprocesa el
  batch completo. Si el handler llama a un LLM a USD 0,02, el loop no sólo
  no avanza: factura. Sin idempotencia, además, duplica efectos.
`);

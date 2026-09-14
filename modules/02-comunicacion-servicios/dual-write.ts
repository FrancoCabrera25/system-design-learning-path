/**
 * Módulo 02 — El problema de la doble escritura, con números.
 *
 *   node modules/02-comunicacion-servicios/dual-write.ts
 *
 * "Guardar en la base y publicar en el broker" son DOS escrituras en DOS
 * sistemas, sin ninguna transacción que las abarque. Entre una y otra hay una
 * ventana de milisegundos en la que, si el proceso muere, el sistema queda
 * inconsistente PARA SIEMPRE y sin ningún error que lo delate.
 *
 * "Milisegundos" suena a nada. Este script calcula a cuántas órdenes rotas
 * por día equivale.
 */

// ---------------------------------------------------------------------------
// Parámetros. Cambialos por los de tu sistema.
// ---------------------------------------------------------------------------
const OPS_POR_DIA = 4_800_000;      // ~55 escrituras/s
const CAIDAS_POR_DIA = 20;          // deploys, OOM kills, spot interruptions,
                                    // drenajes de nodo, crashes. 20/día entre
                                    // todos los pods es CONSERVADOR.

const MS_TRANSACCION_DB = 8;        // lo que tarda el COMMIT
const MS_PUBLICAR = 4;              // lo que tarda el ack del broker
const MS_MARCAR_OUTBOX = 2;         // el UPDATE published_at
const MS_ACK_CONSUMIDOR = 2;        // commit del offset / XACK

const caidasPorSegundo = CAIDAS_POR_DIA / 86_400;

interface Diseno {
  nombre: string;
  /** Ventana en la que morir deja el DATO sin EVENTO. */
  ventanaPerdido: number;
  /** Ventana en la que morir deja el EVENTO sin DATO. */
  ventanaFantasma: number;
  /** Ventana en la que morir produce una entrega repetida (inofensiva si el
   *  consumidor es idempotente). */
  ventanaDuplicado: number;
  nota: string;
}

const DISENOS: Diseno[] = [
  {
    nombre: 'publicar -> guardar',
    ventanaPerdido: 0,
    ventanaFantasma: MS_TRANSACCION_DB,   // publicó y murió antes del COMMIT
    ventanaDuplicado: 0,
    nota: 'evento fantasma: los consumidores procesan una orden que NO EXISTE',
  },
  {
    nombre: 'guardar -> publicar',
    ventanaPerdido: MS_PUBLICAR,          // commiteó y murió antes de publicar
    ventanaFantasma: 0,
    ventanaDuplicado: 0,
    nota: 'evento perdido: la orden existe y nadie se entera. Nunca se reserva el envío',
  },
  {
    nombre: 'OUTBOX',
    ventanaPerdido: 0,                    // el evento está en la MISMA transacción
    ventanaFantasma: 0,
    ventanaDuplicado: MS_MARCAR_OUTBOX,   // publicó y murió antes del UPDATE
    nota: 'nunca pierde ni inventa. Republica: el consumidor idempotente lo absorbe',
  },
  {
    nombre: 'LOG PRIMERO',
    ventanaPerdido: 0,                    // una sola escritura: no hay ventana
    ventanaFantasma: 0,
    ventanaDuplicado: MS_ACK_CONSUMIDOR,  // el consumidor muere antes del ack
    nota: 'una sola escritura en el camino crítico. A cambio: lectura eventual',
  },
];

/** Monte Carlo: ¿cuántas ops caen dentro de cada ventana en un día? */
function simularDia(ventanaMs: number): number {
  if (ventanaMs === 0) return 0;
  const p = caidasPorSegundo * (ventanaMs / 1000);
  let n = 0;
  for (let i = 0; i < OPS_POR_DIA; i++) if (Math.random() < p) n++;
  return n;
}

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log('='.repeat(80));
console.log('  EL PROBLEMA DE LA DOBLE ESCRITURA, EN ÓRDENES ROTAS POR DÍA');
console.log('='.repeat(80));
console.log(`  ${fmt(OPS_POR_DIA)} operaciones/día · ${CAIDAS_POR_DIA} caídas de proceso/día`);
console.log(`  (deploys, OOM, spot interruptions, drenaje de nodos — 20/día es conservador)\n`);
console.log('  diseño                  perdidos  fantasma  duplicados   ROTAS/DÍA   ROTAS/AÑO');
console.log('  ' + '-'.repeat(78));

const resultados: Record<string, { rotas: number; dup: number }> = {};

for (const d of DISENOS) {
  const perdidos = simularDia(d.ventanaPerdido);
  const fantasma = simularDia(d.ventanaFantasma);
  const dup = simularDia(d.ventanaDuplicado);
  const rotas = perdidos + fantasma;
  resultados[d.nombre] = { rotas, dup };

  const icono = rotas > 0 ? '💀' : '✅';
  console.log(
    `  ${d.nombre.padEnd(22)} ${String(perdidos).padStart(8)}  ${String(fantasma).padStart(8)}  ` +
      `${String(dup).padStart(10)}   ${String(rotas).padStart(9)}   ${fmt(rotas * 365).padStart(9)}  ${icono}`,
  );
}

console.log('\n  ' + '-'.repeat(78));
for (const d of DISENOS) console.log(`  ${d.nombre.padEnd(22)} ${d.nota}`);

console.log(`
  CÓMO LEER ESTO

  "ROTAS" son inconsistencias PERMANENTES: el sistema queda mal y no hay
  nada que lo arregle solo. No hay excepción, no hay log de error, no hay
  alerta. La orden existe y el envío nunca se reserva; o al revés, se
  procesa un evento de una orden que no está en ninguna tabla.

  Los DUPLICADOS son de otra categoría: con un consumidor idempotente
  (INSERT ... ON CONFLICT DO NOTHING sobre el eventId, en la misma
  transacción que el efecto) son INOFENSIVOS. Por eso el outbox y el
  consumidor idempotente son el mismo patrón: el outbox cambia un
  problema que no se puede resolver por uno que sí.

  Y notá cuál de los dos errores es peor. "Perdido" es malo: la orden
  existe y nadie la procesa; al menos el dato está y se puede reconciliar.
  "FANTASMA" es peor: los consumidores actúan sobre una orden que NO
  EXISTE — reservan stock, mandan mails, cobran — y no hay ninguna fila
  contra la cual reconciliar. Por eso publicar ANTES de guardar es la
  peor de las cuatro opciones, aunque intuitivamente parezca simétrica.`);

// ---------------------------------------------------------------------------
// El deploy: donde los números se multiplican
// ---------------------------------------------------------------------------
const DEPLOYS_POR_DIA = 5;
const PODS = 12;
const REQUESTS_EN_VUELO_POR_POD = 40;

console.log(`
${'='.repeat(80)}
  Y ESTO ES SIN CONTAR EL DEPLOY MAL HECHO
${'='.repeat(80)}

  Si la app no maneja SIGTERM (dejar de aceptar tráfico, terminar lo que
  está en vuelo, recién ahí salir), cada rolling update MATA las requests
  en curso de cada pod:

     ${DEPLOYS_POR_DIA} deploys/día × ${PODS} pods × ${REQUESTS_EN_VUELO_POR_POD} requests en vuelo = ${fmt(DEPLOYS_POR_DIA * PODS * REQUESTS_EN_VUELO_POR_POD)} requests cortadas/día

  De ésas, las que estaban justo entre la base y el broker quedan rotas.
  Pero además TODAS quedan sin respuesta para el cliente, que reintenta —
  y ahí aparece el otro lado del problema: sin Idempotency-Key, el
  reintento crea una SEGUNDA orden (módulo 06).

  Dos arreglos, y los dos son baratos:
    1. Manejar SIGTERM + 'terminationGracePeriodSeconds' + preStop hook.
    2. Connection draining en el balanceador (módulo 03, A4).

  ${'='.repeat(76)}

  LA PREGUNTA QUE CIERRA EL TEMA

  ¿Cuánto tardarías en enterarte de ${resultados['guardar -> publicar'].rotas} órdenes por día sin evento?

  Sin un job de reconciliación que compare los dos lados
  ("órdenes CONFIRMED sin envío asociado con más de 30 minutos"),
  la respuesta honesta es: te enterás por un cliente, semanas después,
  y nunca vas a saber cuántas hubo antes.

  Ésa es la diferencia real entre el outbox y no tenerlo. No es
  elegancia arquitectónica: son ${fmt(resultados['guardar -> publicar'].rotas * 365)} incidentes silenciosos al año.
`);

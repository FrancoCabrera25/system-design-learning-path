/**
 * Módulo 02 — El publisher del outbox: intervalo, lote y carga sobre la base.
 *
 *   node modules/02-comunicacion-servicios/outbox-polling.ts
 *
 * Responde tres preguntas con números en vez de intuición:
 *   A) ¿Cuánta latencia le agrega el polling? ¿Cuántas queries le cuesta?
 *   B) ¿Cuánto mejora LISTEN/NOTIFY?
 *   C) ¿Qué pasa cuando llegan 50.000 eventos de golpe?
 */

const MS_POR_PUBLICACION = 1.5;   // publicar un evento en Kafka (batcheado)
const OVERHEAD_POLL_MS = 1.2;     // la query al outbox + el UPDATE del lote

function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

interface Resultado {
  p50: number; p99: number;
  queriesPorSeg: number; pollsVacios: number; drenadoMs: number;
  techo: number;            // eventos/s que este publisher puede sostener
}

const DEBOUNCE_NOTIFY_MS = 20;   // al despertar, esperamos un poco y drenamos
                                 // en lote, en vez de un poll por evento

/**
 * @param intervaloMs  cada cuánto despierta el publisher (0 = LISTEN/NOTIFY)
 * @param lote         cuántas filas trae como máximo cada poll (el LIMIT)
 * @param llegadas     momentos (ms) en que se commitea cada evento, ordenados
 * @param duracionMs   ventana simulada
 */
function simular(intervaloMs: number, lote: number, llegadas: number[], duracionMs: number): Resultado {
  const notify = intervaloMs === 0;
  const latencias: number[] = [];
  let cursor = 0, polls = 0, vacios = 0, t = 0, ultimaEntrega = 0;

  while (cursor < llegadas.length || t <= duracionMs) {
    // Cuántos eventos ya están commiteados y sin publicar
    let disponibles = 0;
    while (cursor + disponibles < llegadas.length && llegadas[cursor + disponibles] <= t) disponibles++;

    if (disponibles === 0) {
      if (cursor >= llegadas.length) break;          // no queda nada por hacer
      if (notify) {
        // Estábamos DORMIDOS: el trigger nos despierta. No hubo query vacía.
        t = llegadas[cursor] + DEBOUNCE_NOTIFY_MS;
      } else {
        polls++; vacios++;                            // poll que no encontró nada
        t += intervaloMs;
      }
      continue;
    }

    polls++;
    const n = Math.min(disponibles, lote);
    const fin = t + OVERHEAD_POLL_MS + n * MS_POR_PUBLICACION;
    for (let i = 0; i < n; i++) latencias.push(fin - llegadas[cursor + i]);
    cursor += n;
    ultimaEntrega = fin;

    // Si publicar tardó más que el intervalo, el próximo poll sale enseguida.
    t = notify ? fin : Math.max(fin, t + intervaloMs);
  }

  const ventana = Math.max(ultimaEntrega, duracionMs);
  const msPorLoteLleno = OVERHEAD_POLL_MS + lote * MS_POR_PUBLICACION;
  return {
    p50: percentil(latencias, 50),
    p99: percentil(latencias, 99),
    queriesPorSeg: (polls / ventana) * 1000 * 2,      // SELECT + UPDATE
    pollsVacios: (vacios / polls) * 100,
    drenadoMs: ultimaEntrega,
    // techo: cuántos eventos/s puede sostener. Si el lote entra holgado en el
    // intervalo, manda el intervalo; si no, manda el tiempo de publicación.
    techo: notify
      ? (lote / msPorLoteLleno) * 1000
      : (lote / Math.max(intervaloMs, msPorLoteLleno)) * 1000,
  };
}

// ---------------------------------------------------------------------------
// A) Carga normal
// ---------------------------------------------------------------------------
const EVENTOS_POR_SEG = 200;
const DURACION = 60_000;
const llegadasNormales = Array.from(
  { length: (EVENTOS_POR_SEG * DURACION) / 1000 },
  (_, i) => (i * 1000) / EVENTOS_POR_SEG,
);

const QPS_APP = 3_000;   // lo que la aplicación ya le pide a Postgres

console.log('='.repeat(78));
console.log(`  A) CARGA NORMAL — ${EVENTOS_POR_SEG} eventos/s, lote de 100`);
console.log('='.repeat(78));
console.log(`  La app ya hace ${QPS_APP.toLocaleString('es-AR')} queries/s contra Postgres. ¿Cuánto agrega el publisher?\n`);
console.log('  intervalo      p50        p99     queries/s   % del total   techo (ev/s)');
console.log('  ' + '-'.repeat(74));

const fila = (nombre: string, r: Resultado) => {
  const ahogado = r.techo < EVENTOS_POR_SEG ? '  💀 no da abasto' : '';
  console.log(
    `  ${nombre.padEnd(13)} ${r.p50.toFixed(0).padStart(7)} ms ${r.p99.toFixed(0).padStart(8)} ms ` +
      `${r.queriesPorSeg.toFixed(1).padStart(10)} ${((r.queriesPorSeg / QPS_APP) * 100).toFixed(2).padStart(11)} % ` +
      `${r.techo.toFixed(0).padStart(11)}${ahogado}`,
  );
};

for (const intervalo of [1000, 500, 200, 100, 50]) fila(`${intervalo} ms`, simular(intervalo, 100, llegadasNormales, DURACION));
fila('LISTEN/NOTIFY', simular(0, 100, llegadasNormales, DURACION));

console.log(`
  LO QUE HAY QUE VER

  La columna "% del total" es la respuesta a "¿no saturamos la base?".
  Incluso polleando cada 50 ms, el publisher es una fracción ínfima de
  la carga que la aplicación ya genera. Y esa query es un index scan
  sobre un índice PARCIAL que contiene sólo las filas pendientes —
  decenas de filas, no millones:

     CREATE INDEX idx_outbox_pendientes ON outbox (id)
       WHERE published_at IS NULL;          <-- el WHERE es todo

  SIN ese índice parcial la query es un seq scan sobre una tabla que
  crece para siempre, y ahí sí saturás la base — cada día un poco más.
  El patrón no es caro; la implementación ingenua sí.

  El intervalo es, simplemente, latencia que le agregás al evento.
  LISTEN/NOTIFY la baja a decenas de milisegundos sin polling agresivo:
  el trigger despierta al publisher, que espera ${DEBOUNCE_NOTIFY_MS} ms para agrupar y
  drena en lote. Ese debounce importa: sin él, NOTIFY dispara un poll
  POR EVENTO y terminás con más queries que polleando. El poll lento
  queda como red de seguridad, porque NOTIFY es best-effort — si el
  publisher estaba reconectando, se pierde el aviso.

  Fijate que a ${EVENTOS_POR_SEG} eventos/s NOTIFY hace MÁS queries que pollear cada
  50 ms: despierta seguido y drena lotes chicos. Su ventaja no está acá,
  está cuando el ritmo es bajo o irregular: con 2 eventos por minuto, el
  polling cada 200 ms hace 600 queries vacías por minuto y NOTIFY hace 2.
  Elegí según tu tasa de eventos, no por moda.

  Y MIRÁ LA ÚLTIMA COLUMNA, que es la trampa de esta configuración:
  con lote de 100 y polls cada 1000 ms, el publisher sólo puede sostener
  100 eventos/s. Llegan ${EVENTOS_POR_SEG}. El backlog crece para siempre y la latencia
  se va a decenas de segundos — no porque el polling sea lento, sino
  porque LOTE / INTERVALO quedó por debajo de la tasa de eventos.

     techo de eventos/s = lote / intervalo

  Es la Ley de Little otra vez (módulo 01), disfrazada de parámetro de
  configuración. Dimensionalo con margen: 3-5x la tasa pico de eventos.`);

// ---------------------------------------------------------------------------
// B) La ráfaga: 50.000 eventos de golpe
// ---------------------------------------------------------------------------
const RAFAGA = 50_000;
const llegadasRafaga = Array.from({ length: RAFAGA }, () => 0);

console.log(`\n${'='.repeat(78)}`);
console.log(`  B) LA RÁFAGA — ${RAFAGA.toLocaleString('es-AR')} eventos commiteados de golpe`);
console.log('='.repeat(78));
console.log('  (una migración, un backfill, un reproceso masivo)\n');
console.log('  lote (LIMIT)   tiempo en drenar    polls   latencia p99 del evento');
console.log('  ' + '-'.repeat(70));

for (const lote of [10, 100, 500, 1_000, 5_000]) {
  const r = simular(200, lote, llegadasRafaga, 0);
  const seg = r.drenadoMs / 1000;
  const alarma = seg > 120 ? '  💀' : seg > 30 ? '  ⚠️ ' : '  ✅';
  console.log(
    `  ${String(lote).padStart(9)}    ${seg.toFixed(1).padStart(10)} s    ` +
      `${Math.round(r.queriesPorSeg * seg / 2).toLocaleString('es-AR').padStart(7)}   ${(r.p99 / 1000).toFixed(1).padStart(8)} s${alarma}`,
  );
}

console.log(`
  ACÁ APARECE EL PARÁMETRO QUE CASI NADIE CALIBRA: el LIMIT.

  Con lote de 10 y polls cada 200 ms, el techo es 50 eventos/s: drenar
  50.000 tarda 17 MINUTOS, y el último evento de la ráfaga llega con
  16 minutos de atraso. El publisher no está lento: está estrangulado
  por su propio LIMIT.

  A partir de un lote de ~500 el intervalo deja de mandar y el cuello de
  botella pasa a ser la publicación misma (${(1000 / MS_POR_PUBLICACION).toFixed(0)} eventos/s con ${MS_POR_PUBLICACION} ms
  cada uno). De ahí en adelante, agrandar el lote ya no compra nada.

  Pero el lote NO se sube infinitamente:
   - Una transacción larga que toca miles de filas bloquea VACUUM y
     alarga el WAL.
   - Si el proceso muere a mitad del lote, republicás TODO el lote
     (at-least-once: el consumidor idempotente se lo come, pero es
     trabajo repetido).
   - Un lote de 5.000 con payloads de 25 KB son 125 MB en memoria.

  Rango práctico: 100 a 1.000. Y si la ráfaga es habitual, la solución
  no es un lote gigante sino VARIOS PUBLISHERS con
  FOR UPDATE SKIP LOCKED, que es la cláusula de Postgres que permite
  que N procesos tomen lotes distintos sin pisarse y sin ningún lock
  distribuido. (Costo: perdés el orden global entre eventos. Si
  necesitás orden por agregado, particioná el polling por aggregate_id.)

  LA ALERTA QUE HAY QUE TENER, en cualquier caso, no es sobre la
  cantidad de filas pendientes sino sobre su ANTIGÜEDAD:

     SELECT now() - min(created_at) FROM outbox WHERE published_at IS NULL;

  Si el publisher se muere, las órdenes se siguen creando perfectamente,
  nadie ve un error en ningún lado, y los envíos no se reservan nunca.
  Sin esta alerta te enterás por un cliente, tres días después.
`);

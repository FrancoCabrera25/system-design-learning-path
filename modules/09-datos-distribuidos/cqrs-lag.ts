/**
 * Módulo 09 — El costo que no se negocia de CQRS nivel 4.
 *
 *   node modules/09-datos-distribuidos/cqrs-lag.ts
 *
 * Separar el modelo de lectura del de escritura significa que hay un momento
 * en que la escritura ya ocurrió y la proyección todavía no la tiene.
 *
 * El usuario crea algo y NO LO VE EN LA LISTA. Y a diferencia del lag de una
 * réplica (módulo 05), acá el camino es mucho más largo.
 */

const LECTURAS = 300_000;
const ESCRITURAS_SEG = 300;

/**
 * El lag de una PROYECCIÓN, sumando todo el camino:
 *
 *   commit del comando -> outbox publisher (intervalo) -> broker ->
 *   poll del consumer -> procesar -> commit de la proyección
 *
 * Por eso es mucho peor que el lag de una réplica, que es un solo salto.
 */
function lagProyeccionMs(): number {
  const r = Math.random();
  if (r < 0.85) return 60 + Math.random() * 240;        // 85%: camino feliz, 60-300 ms
  if (r < 0.98) return 300 + Math.random() * 1_700;     // 13%: poll lento, lote grande
  if (r < 0.997) return 2_000 + Math.random() * 8_000;  // 1,7%: rebalance, pico de carga
  return 30_000 + Math.random() * 270_000;              // 0,3%: reconstrucción, backlog
}

/** Para comparar: una réplica de lectura es UN salto (módulo 05). */
function lagReplicaMs(): number {
  const r = Math.random();
  if (r < 0.92) return 5 + Math.random() * 25;
  if (r < 0.995) return 30 + Math.random() * 370;
  return 400 + Math.random() * 1_600;
}

function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// A) El lag de la proyección vs el de una réplica
// ---------------------------------------------------------------------------
const muestrasProy = Array.from({ length: 50_000 }, lagProyeccionMs);
const muestrasRepl = Array.from({ length: 50_000 }, lagReplicaMs);

console.log('='.repeat(80));
console.log('  A) EL LAG DE UNA PROYECCIÓN ES DE OTRO ORDEN QUE EL DE UNA RÉPLICA');
console.log('='.repeat(80));
console.log('\n            réplica de lectura    proyección de CQRS     cuántas veces peor');
console.log('  ' + '-'.repeat(76));
for (const p of [50, 90, 99, 99.9]) {
  const r = percentil(muestrasRepl, p), q = percentil(muestrasProy, p);
  console.log(
    `  p${String(p).padEnd(5)} ${fmt(r).padStart(15)} ms ${fmt(q).padStart(21)} ms ${fmt(q / r, 1).padStart(20)}x`,
  );
}

console.log(`
  Una réplica es UN salto: el WAL del primario a la réplica.
  Una proyección son CINCO: commit -> outbox -> broker -> poll -> procesar.

  Cada salto suma su propia latencia Y su propia cola. Por eso el p99 de una
  proyección se mide en segundos y el de una réplica en cientos de ms.`);

// ---------------------------------------------------------------------------
// B) Cuántos usuarios no ven su propia escritura
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(80)}`);
console.log('  B) "CREÉ EL PRODUCTO Y NO APARECE EN LA LISTA"');
console.log('='.repeat(80));
console.log('\n  cuándo lee el front            % que NO ve su escritura   usuarios/s afectados');
console.log('  ' + '-'.repeat(76));

const CASOS: [string, number][] = [
  ['inmediatamente (SPA refetch)', 0],
  ['200 ms después', 200],
  ['500 ms después', 500],
  ['1 s después', 1_000],
  ['3 s (el usuario aprieta F5)', 3_000],
  ['10 s después', 10_000],
];

for (const [nombre, retraso] of CASOS) {
  let viejos = 0;
  for (let i = 0; i < LECTURAS; i++) if (lagProyeccionMs() > retraso) viejos++;
  const pct = (viejos / LECTURAS) * 100;
  const icono = pct > 50 ? '💀' : pct > 5 ? '⚠️ ' : '✅';
  console.log(
    `  ${nombre.padEnd(30)} ${pct.toFixed(2).padStart(21)} %   ` +
      `${fmt(ESCRITURAS_SEG * (pct / 100), 1).padStart(12)}  ${icono}`,
  );
}

console.log(`
  El caso de arriba es el normal en una SPA: hacés el POST, recibís 201, y
  disparás el GET para refrescar la lista. CON CQRS NIVEL 4, ESO FALLA
  SIEMPRE.

  Y es el mismo bug del caso 07 ("a veces no se guarda") con otra causa: no
  es el lag de una réplica, es el lag de la proyección. Mismo síntoma, mismo
  "no reproducible", y peor magnitud.

  A ${fmt(ESCRITURAS_SEG)} escrituras/s, son cientos de usuarios por segundo viendo que su
  trabajo "no se guardó". Y el p99.9 de 30+ segundos convierte una
  reconstrucción de proyección en un incidente de producto: durante esos
  minutos, NADIE ve lo que escribe.`);

// ---------------------------------------------------------------------------
// C) Las mitigaciones, por costo
// ---------------------------------------------------------------------------
const RATIO_LECTURA_ESCRITURA = 20;
const LECTURAS_ARRASTRADAS = 3;
const VENTANA_S = 5;

const fraccionAlModeloEscritura = LECTURAS_ARRASTRADAS / RATIO_LECTURA_ESCRITURA;

// ¿Qué tan seguido la ventana de 5 s no alcanza? (el p99.9 de 30 s)
let noAlcanza = 0;
for (let i = 0; i < LECTURAS; i++) if (lagProyeccionMs() > VENTANA_S * 1000) noAlcanza++;

console.log(`\n${'='.repeat(80)}`);
console.log('  C) LAS MITIGACIONES, ORDENADAS POR COSTO');
console.log('='.repeat(80));
console.log(`
  1. EL COMANDO DEVUELVE EL RESULTADO.                   costo: CERO
     El POST devuelve el recurso creado y el front lo usa, en vez de
     refetchear la lista. Resuelve el caso que falla el 100% de las veces,
     sin tocar nada de infraestructura.

     ✅ En React Query: setQueryData, NO invalidateQueries.
     ⚠️  No cubre la LISTA de otros usuarios, ni el agregado ("total de
        productos"), que siguen viniendo de la proyección.

  2. UI OPTIMISTA CON ESTADO EXPLÍCITO.                  costo: bajo (front)
     Insertás el item en la lista local marcado como "procesando", y lo
     confirmás cuando llega el evento por WebSocket/SSE.
     Es la solución que mejor se siente, porque convierte la consistencia
     eventual en INFORMACIÓN en vez de en un bug.

  3. LEER DEL MODELO DE ESCRITURA POR ${VENTANA_S} s.              costo: medio
     Una marca en la sesión; el router de lecturas la mira (igual que el
     caso 07). Con ratio ${RATIO_LECTURA_ESCRITURA}:1 y ~${LECTURAS_ARRASTRADAS} lecturas arrastradas por escritura,
     mandás al modelo de escritura el ${(fraccionAlModeloEscritura * 100).toFixed(0)}% de las lecturas.

     ⚠️  Y acá está la trampa de CQRS: el modelo de escritura NO SABE
        responder la query de la proyección. Si la proyección existe porque
        la query necesitaba 7 JOINs o un índice full-text, "leer del modelo
        de escritura" significa correr esos 7 JOINs — que es exactamente lo
        que querías evitar.
        Sólo funciona para lecturas SIMPLES (traer el item por id).

     ⚠️  Y la ventana de ${VENTANA_S} s no alcanza el ${((noAlcanza / LECTURAS) * 100).toFixed(2)}% de las veces (el p99.9).

  4. ESPERAR LA VERSIÓN DE LA PROYECCIÓN.                costo: alto
     El comando devuelve la posición del evento; la lectura espera a que la
     proyección la alcance, o cae al modelo de escritura.

         POST /productos -> 201 { id, _version: 48213 }
         GET /productos?minVersion=48213
           -> la proyección guarda su última versión procesada
           -> si todavía no llegó: espera un poco, o 409 + Retry-After

     Correcto por construcción, y hay que plomearlo por toda la aplicación.
     Vale para 3 endpoints críticos, no para 200.

  LA PREGUNTA QUE ORDENA LA DECISIÓN — y es la misma del caso 07:

     ¿QUÉ LECTURAS DE ESTE SISTEMA NECESITAN VER LA PROPIA ESCRITURA?

     "El producto que acabás de crear"       -> SÍ
     "El listado filtrado y paginado"        -> casi nunca
     "El dashboard de métricas"              -> no
     "El buscador"                           -> no

  Es una decisión POR ENDPOINT. Y si la respuesta es "todas", entonces
  CQRS nivel 4 no es para este dominio: el nivel 3 (vistas materializadas
  en la misma base, refrescadas en la misma transacción) te da el 80% del
  beneficio SIN consistencia eventual.
`);

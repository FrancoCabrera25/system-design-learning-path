/**
 * Módulo 05 — "A veces no se guarda": el bug del replication lag.
 *
 *   node modules/05-bases-de-datos/replication-lag.ts
 *
 * El usuario guarda su perfil (va al PRIMARIO), la pantalla recarga (lee de
 * una RÉPLICA) y ve los datos viejos. No hay ningún error en ningún log.
 *
 * "El lag es de 20 ms, no puede ser eso." Este script muestra por qué sí.
 */

const LECTURAS = 500_000;

/**
 * Lag realista de una réplica: casi siempre chico, con cola larga.
 *   92%  -> 5-30 ms    (operación normal)
 *   7%   -> 30-400 ms  (checkpoint, pico de escrituras, vacuum)
 *   1%   -> 0,4-8 s    (batch job, migración, backup, red degradada)
 */
function lagMs(): number {
  const r = Math.random();
  if (r < 0.92) return 5 + Math.random() * 25;
  if (r < 0.99) return 30 + Math.random() * 370;
  return 400 + Math.random() * 7600;
}

function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

const muestras = Array.from({ length: 50_000 }, lagMs);
const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log('='.repeat(78));
console.log('  EL LAG DE LA RÉPLICA (lo que muestra tu dashboard)');
console.log('='.repeat(78));
console.log(`  p50  ${percentil(muestras, 50).toFixed(0).padStart(6)} ms      <-- el número que mira todo el mundo`);
console.log(`  p90  ${percentil(muestras, 90).toFixed(0).padStart(6)} ms`);
console.log(`  p99  ${percentil(muestras, 99).toFixed(0).padStart(6)} ms`);
console.log(`  p99.9${percentil(muestras, 99.9).toFixed(0).padStart(6)} ms`);
console.log(`  max  ${Math.max(...muestras).toFixed(0).padStart(6)} ms`);

// ---------------------------------------------------------------------------
// Cuántos usuarios ven el dato viejo
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log('  ¿CUÁNTOS USUARIOS VEN EL DATO VIEJO DESPUÉS DE GUARDAR?');
console.log('='.repeat(78));
console.log('\n  cuándo relee el front           % que ve datos VIEJOS    a 500 escrituras/s');
console.log('  ' + '-'.repeat(74));

const CASOS: [string, number][] = [
  ['inmediatamente (SPA refetch)', 0],
  ['50 ms después', 50],
  ['200 ms después', 200],
  ['500 ms después', 500],
  ['1 s después', 1_000],
  ['3 s (el usuario aprieta F5)', 3_000],
];

const ESCRITURAS_POR_SEG = 500;

for (const [nombre, retraso] of CASOS) {
  let viejos = 0;
  for (let i = 0; i < LECTURAS; i++) if (lagMs() > retraso) viejos++;
  const pct = (viejos / LECTURAS) * 100;
  const porSegundo = ESCRITURAS_POR_SEG * (pct / 100);
  const icono = pct > 10 ? '💀' : pct > 1 ? '⚠️ ' : '✅';
  console.log(
    `  ${nombre.padEnd(32)} ${pct.toFixed(2).padStart(10)} %          ` +
      `${fmt(porSegundo, 1).padStart(8)} usuarios/s  ${icono}`,
  );
}

console.log(`
  LEER ASÍ: el caso más común en una SPA es el PRIMERO. Hacés el POST,
  recibís 200, e inmediatamente disparás el GET para refrescar la pantalla.
  Con un lag p50 de ${percentil(muestras, 50).toFixed(0)} ms, prácticamente TODAS esas lecturas llegan
  antes que el dato.

  A 500 escrituras/s, eso son cientos de usuarios por segundo viendo
  "no se guardó". Y no hay ningún error: el POST devolvió 200, el GET
  devolvió 200, los dos con datos perfectamente válidos.

  Por eso este bug llega a soporte como "a veces no se guarda" y se
  cierra como "no reproducible" — porque el que lo reproduce a mano
  tarda más de 3 segundos en mirar, y a esa altura ya está replicado.`);

// ---------------------------------------------------------------------------
// El pico: cuando el lag se dispara
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}`);
console.log('  Y CUANDO EL LAG SE DISPARA (migración, batch, backup)');
console.log('='.repeat(78));

const lagPico = () => 2_000 + Math.random() * 28_000;   // 2 a 30 segundos
let viejosPico = 0;
for (let i = 0; i < LECTURAS; i++) if (lagPico() > 3_000) viejosPico++;

console.log(`
  Con la réplica 2-30 s atrás, incluso el usuario que espera 3 segundos
  ve datos viejos el ${((viejosPico / LECTURAS) * 100).toFixed(0)} % de las veces.

  Y acá aparece lo grave: durante ese pico, la aplicación NO SE CAE.
  Sigue respondiendo 200 a todo, con datos de hace medio minuto. Los
  usuarios crean cosas duplicadas porque "no aparecieron", cancelan
  operaciones que sí ocurrieron, y las métricas de error están en cero.

  ALERTA MÍNIMA:  SELECT now() - pg_last_xact_replay_timestamp();
  con umbral en segundos. Sin esto, un pico de lag es invisible.`);

// ---------------------------------------------------------------------------
// Las soluciones, con su costo
// ---------------------------------------------------------------------------
const RATIO_LECTURA_ESCRITURA = 12;
const VENTANA_S = 5;

// Fracción de las lecturas que ocurren dentro de la ventana posterior a una
// escritura DEL MISMO usuario. Aproximación: cada escritura "arrastra" unas
// pocas lecturas de ese usuario en los segundos siguientes.
const LECTURAS_ARRASTRADAS = 2.5;
const fraccionAlPrimario = LECTURAS_ARRASTRADAS / RATIO_LECTURA_ESCRITURA;

console.log(`\n${'='.repeat(78)}`);
console.log('  LAS SOLUCIONES, ORDENADAS POR COSTO');
console.log('='.repeat(78));
console.log(`
  1. QUE EL POST DEVUELVA EL RECURSO ACTUALIZADO.       costo: CERO
     El front usa la respuesta que ya tiene y no hace la segunda query.
     La solución más barata es no hacer la lectura. Resuelve el caso más
     común (el refetch inmediato) sin tocar la infraestructura.

  2. LEER DEL PRIMARIO POR ${VENTANA_S} s DESPUÉS DE ESCRIBIR.        costo: bajo
     Una marca en la sesión o una cookie con timestamp; el router de
     lecturas la mira. Con un ratio de ${RATIO_LECTURA_ESCRITURA}:1 y ~${LECTURAS_ARRASTRADAS} lecturas arrastradas
     por escritura, mandás al primario el ${(fraccionAlPrimario * 100).toFixed(0)} % de las lecturas.
     Seguís sacándole al primario el ${((1 - fraccionAlPrimario) * 100).toFixed(0)} % del tráfico de lectura.

  3. ESPERAR EL LSN.                                    costo: medio
     La escritura devuelve su posición en el WAL (pg_current_wal_lsn());
     la lectura espera a que la réplica la alcance, o cae al primario.
     Correcto de verdad, y hay que plomearlo por toda la aplicación.

  4. LEER SIEMPRE DEL PRIMARIO.                         costo: alto
     Resuelve el problema y tira a la basura la razón por la que tenías
     réplicas. Válido para un subconjunto de endpoints críticos; como
     política general, no.

  LA PREGUNTA QUE ORDENA LA DECISIÓN, y conviene hacerla explícita:

     ¿Qué lecturas de este sistema NECESITAN read-your-writes?

  Casi nunca son todas. El perfil que acabás de editar, sí. El listado
  de productos, el feed, las notificaciones: no. Es una decisión POR
  ENDPOINT, no una configuración global — y plantearla así es lo que
  distingue una respuesta de senior en una entrevista.
`);

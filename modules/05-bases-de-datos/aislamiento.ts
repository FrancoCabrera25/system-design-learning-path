/**
 * Módulo 05 — Aislamiento: los bugs que el default de Postgres deja pasar.
 *
 *   node modules/05-bases-de-datos/aislamiento.ts
 *
 * Simulamos transacciones concurrentes con un planificador que las interleava
 * al azar — que es exactamente lo que hace la base cuando N pods le pegan a la
 * misma fila. Usamos generadores: cada 'yield' es un punto donde otra
 * transacción se puede meter en el medio.
 *
 * Esto es la base directa del módulo 06 (idempotencia y locks).
 */

// ---------------------------------------------------------------------------
// El planificador: ejecuta N transacciones interleavándolas al azar
// ---------------------------------------------------------------------------
function ejecutarConcurrente(transacciones: Generator<void>[]): void {
  const vivas = transacciones.map((g) => ({ g, terminada: false }));
  let quedan = vivas.length;
  let guardia = 0;

  while (quedan > 0 && guardia++ < 5_000_000) {
    const i = Math.floor(Math.random() * vivas.length);
    const t = vivas[i];
    if (t.terminada) continue;
    if (t.g.next().done) { t.terminada = true; quedan--; }
  }
}

// ===========================================================================
// ESCENARIO 1 — LOST UPDATE: vender más de lo que tenés
// ===========================================================================

const STOCK_INICIAL = 100;
const COMPRADORES = 500;

interface DB { stock: number; version: number; lock: number | null; }
interface Resultado { vendidos: number; stockFinal: number; reintentos: number; }

type Estrategia = (db: DB, w: { vendio: boolean; reintentos: number }) => Generator<void>;

/** (a) SELECT + if + UPDATE con el valor leído. Lo que escribe todo el mundo. */
function* leerEscribir(db: DB, w: { vendio: boolean }): Generator<void> {
  const leido = db.stock;                 // SELECT stock FROM productos WHERE id=1
  yield;                                   // <-- otra transacción puede meterse acá
  if (leido <= 0) return;
  yield;
  db.stock = leido - 1;                    // UPDATE ... SET stock = <leido> - 1
  w.vendio = true;
}

/** (b) UPDATE atómico: que la resta la haga la base. */
function* atomico(db: DB, w: { vendio: boolean }): Generator<void> {
  yield;
  // UPDATE productos SET stock = stock - 1 WHERE id = 1 AND stock > 0
  // Es UNA operación: la base la serializa sobre la fila.
  if (db.stock > 0) { db.stock -= 1; w.vendio = true; }
}

/** (c) Lock optimista con columna de versión (el @Version de TypeORM). */
function* optimista(db: DB, w: { vendio: boolean; reintentos: number }): Generator<void> {
  for (let intento = 0; intento < 200; intento++) {
    const leido = db.stock;
    const version = db.version;
    yield;
    if (leido <= 0) return;
    // UPDATE ... SET stock = ?, version = ? WHERE id = 1 AND version = ?
    if (db.version === version) {
      db.stock = leido - 1;
      db.version += 1;
      w.vendio = true;
      return;
    }
    w.reintentos += 1;                     // alguien nos ganó: reintentamos
    yield;
  }
}

/** (d) Lock pesimista: SELECT ... FOR UPDATE. */
function* pesimista(db: DB, w: { vendio: boolean }): Generator<void> {
  while (db.lock !== null) yield;          // la fila está tomada: esperamos
  db.lock = 1;
  const leido = db.stock;
  yield;
  if (leido > 0) { db.stock = leido - 1; w.vendio = true; }
  db.lock = null;                          // COMMIT libera el lock
}

function correrEscenario1(estrategia: Estrategia): Resultado {
  const db: DB = { stock: STOCK_INICIAL, version: 0, lock: null };
  const workers = Array.from({ length: COMPRADORES }, () => ({ vendio: false, reintentos: 0 }));
  ejecutarConcurrente(workers.map((w) => estrategia(db, w)));
  return {
    vendidos: workers.filter((w) => w.vendio).length,
    stockFinal: db.stock,
    reintentos: workers.reduce((a, w) => a + w.reintentos, 0),
  };
}

console.log('='.repeat(80));
console.log(`  ESCENARIO 1 — LOST UPDATE: ${STOCK_INICIAL} unidades, ${COMPRADORES} compradores simultáneos`);
console.log('='.repeat(80));
console.log('  Lo correcto: vender exactamente 100 y quedar en 0.\n');
console.log('  estrategia                      vendidos   stock final   reintentos   resultado');
console.log('  ' + '-'.repeat(78));

const ESTRATEGIAS: [string, Estrategia][] = [
  ['SELECT + if + UPDATE', leerEscribir as Estrategia],
  ['UPDATE stock = stock - 1', atomico as Estrategia],
  ['lock optimista (version)', optimista],
  ['SELECT ... FOR UPDATE', pesimista as Estrategia],
];

for (const [nombre, fn] of ESTRATEGIAS) {
  const r = correrEscenario1(fn);
  const sobreventa = r.vendidos - STOCK_INICIAL;
  const veredicto =
    sobreventa > 0 ? `💀 vendiste ${sobreventa} que no tenías` :
    r.vendidos < STOCK_INICIAL ? `⚠️  vendiste ${STOCK_INICIAL - r.vendidos} de menos` : '✅ correcto';
  console.log(
    `  ${nombre.padEnd(30)} ${String(r.vendidos).padStart(8)}   ${String(r.stockFinal).padStart(11)}   ` +
      `${String(r.reintentos).padStart(10)}   ${veredicto}`,
  );
}

console.log(`
  LO QUE HAY QUE VER

  La primera fila es el código que escribe el 90% de la gente, y es el bug
  más caro de esta lista: leés el stock, decidís, y escribís un valor que
  calculaste con información YA VIEJA. Entre tu SELECT y tu UPDATE pasaron
  otras 50 transacciones.

  Y esto pasa con el nivel de aislamiento POR DEFECTO de Postgres
  (READ COMMITTED), sin que nada falle ni se loguee. No es un bug de
  concurrencia exótico: es el comportamiento documentado.

  LAS TRES SOLUCIONES, Y CUÁNDO USAR CADA UNA

   UPDATE atómico     -> cuando la operación se puede expresar como una
                         sola sentencia. ES LA MEJOR: sin locks, sin
                         reintentos, sin round-trips extra. Si podés
                         escribir 'SET stock = stock - 1 WHERE stock > 0',
                         no uses nada más.

   Lock optimista     -> cuando entre el SELECT y el UPDATE hay lógica de
                         negocio que no entra en una sentencia. Barato si
                         la contención es BAJA; con contención alta los
                         reintentos se comen todo (mirá la columna).

   SELECT FOR UPDATE  -> cuando la contención es alta y necesitás que la
                         operación no falle. Costo: las transacciones se
                         serializan sobre esa fila, así que esa fila se
                         convierte en el cuello de botella de todo el
                         sistema. Y si dos transacciones toman filas en
                         ORDEN DISTINTO, hay deadlock.`);

// ===========================================================================
// ESCENARIO 2 — WRITE SKEW: el que sobrevive a REPEATABLE READ
// ===========================================================================

const INTENTOS = 10_000;

interface Guardia { deTurno: boolean[]; lockGlobal: boolean; }

/** Cada médico consulta cuántos hay de turno y, si hay más de uno, se va. */
function* darseDeBaja(g: Guardia, medico: number): Generator<void> {
  const deTurno = g.deTurno.filter(Boolean).length;   // SELECT count(*) WHERE de_turno
  yield;                                              // <-- el otro médico lee acá
  if (deTurno >= 2) {
    g.deTurno[medico] = false;                        // UPDATE mi propia fila
  }
}

/** Con SELECT ... FOR UPDATE sobre TODAS las filas leídas. */
function* darseDeBajaConLock(g: Guardia, medico: number): Generator<void> {
  while (g.lockGlobal) yield;
  g.lockGlobal = true;
  const deTurno = g.deTurno.filter(Boolean).length;
  yield;
  if (deTurno >= 2) g.deTurno[medico] = false;
  g.lockGlobal = false;
}

function correrEscenario2(fn: (g: Guardia, m: number) => Generator<void>): number {
  let sinNadie = 0;
  for (let i = 0; i < INTENTOS; i++) {
    const g: Guardia = { deTurno: [true, true], lockGlobal: false };
    ejecutarConcurrente([fn(g, 0), fn(g, 1)]);
    if (g.deTurno.filter(Boolean).length === 0) sinNadie++;
  }
  return sinNadie;
}

console.log(`\n${'='.repeat(80)}`);
console.log('  ESCENARIO 2 — WRITE SKEW: dos médicos de guardia, la regla es que quede uno');
console.log('='.repeat(80));
console.log(`  Los dos piden darse de baja al mismo tiempo. ${fmt(INTENTOS)} veces.\n`);

const sinLock = correrEscenario2(darseDeBaja);
const conLock = correrEscenario2(darseDeBajaConLock);

console.log(`  sin lock (READ COMMITTED)          la guardia quedó VACÍA ${fmt(sinLock)} veces  (${((sinLock / INTENTOS) * 100).toFixed(1)} %)  💀`);
console.log(`  SELECT FOR UPDATE de lo leído      la guardia quedó VACÍA ${fmt(conLock)} veces  (${((conLock / INTENTOS) * 100).toFixed(1)} %)  ✅`);

console.log(`
  POR QUÉ ESTO ES DISTINTO AL ESCENARIO 1, Y POR QUÉ ES PEOR

  Acá cada transacción modifica SU PROPIA FILA. No hay conflicto de
  escritura: nadie pisa a nadie. Por eso:

    - Ningún lock de fila lo detecta (cada uno bloquea una fila distinta).
    - REPEATABLE READ tampoco lo evita: los dos leyeron un snapshot
      perfectamente válido. El problema es que la DECISIÓN se tomó sobre
      un estado que dejó de ser cierto.

  Se llama WRITE SKEW y sólo lo evitan dos cosas:

    1. SERIALIZABLE. Postgres detecta el conflicto de lectura-escritura y
       aborta una con error 40001. Tu código TIENE que reintentar — si no
       lo hace, cambiaste un bug silencioso por un error 500.
    2. Materializar la invariante y bloquearla: un lock explícito sobre
       algo que represente "la guardia" (una fila de guardias, o un
       advisory lock), no sobre los médicos.

  DÓNDE APARECE ESTO EN LA VIDA REAL
    - Reservar el último asiento / la última habitación
    - "Máximo 3 sesiones activas por usuario"
    - "El saldo no puede quedar negativo" con varias cuentas
    - Aprobaciones: "hacen falta 2 aprobadores" y los dos se retractan
    - Y el del módulo 06: dos requests con la misma Idempotency-Key
      haciendo SELECT antes del INSERT

  LA REGLA QUE SE LLEVA UNO DE ACÁ

    Si tu decisión depende de una consulta previa, entre esa consulta y
    tu escritura el mundo pudo cambiar. O la base te lo garantiza
    (atómico, lock, SERIALIZABLE), o tenés un bug — aunque no se note
    hoy, y aunque los tests pasen.
`);

function fmt(n: number): string { return n.toLocaleString('es-AR'); }

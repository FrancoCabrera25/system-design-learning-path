/**
 * Módulo 09 — La letra que le falta a las sagas: la "I" de aislamiento.
 *
 *   node modules/09-datos-distribuidos/saga-anomalias.ts
 *
 * Una transacción de base de datos te da ACID. Una saga te da ACD: cada paso
 * COMMITEA DE VERDAD en su base, así que el estado intermedio de una saga en
 * curso es VISIBLE para todo el mundo. No hay nada que lo esconda.
 *
 * De ahí salen dos anomalías que NO EXISTEN en una transacción, y la segunda
 * sorprende hasta a gente que implementó sagas.
 */

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

/** Interleava generadores al azar: cada `yield` es un punto de entrelazado. */
function concurrente(gens: Generator<void>[]): void {
  const vivos = gens.map((g) => ({ g, fin: false }));
  let quedan = vivos.length;
  let guardia = 0;
  while (quedan > 0 && guardia++ < 100_000) {
    const t = vivos[Math.floor(Math.random() * vivos.length)];
    if (t.fin) continue;
    if (t.g.next().done) { t.fin = true; quedan--; }
  }
}

// ===========================================================================
// ANOMALÍA 1 — DIRTY READ entre sagas
// ===========================================================================
//
// La saga A reserva la última unidad y commitea. La saga B lee el stock, ve 0,
// y RECHAZA la venta al cliente. Después la saga A falla en el cobro y compensa:
// devuelve la unidad.
//
// Resultado: rechazaste una venta que SÍ podías hacer. El dato que B leyó era
// real —A había commiteado— pero fue revertido. Es un dirty read, y en una
// transacción de base de datos sería imposible.

const INTENTOS = 20_000;
const P_FALLA_COBRO = 0.30;        // 30% de los cobros fallan y compensan

interface Mundo { stock: number; reservadoPor: string | null; }

/** Saga A: reserva -> cobra -> (si falla) compensa. */
function* sagaQueCompensa(m: Mundo, usaSemanticLock: boolean, falla: boolean): Generator<void> {
  if (m.stock <= 0) return;
  m.stock -= 1;                                   // PASO 1: reserva. COMMITEA.
  if (usaSemanticLock) m.reservadoPor = 'A';      // "esto está en curso"
  yield;                                           // <-- B se mete acá
  yield;
  if (falla) {                                     // PASO 2: el cobro falla
    m.stock += 1;                                  // COMPENSACIÓN
    if (usaSemanticLock) m.reservadoPor = null;
  } else if (usaSemanticLock) {
    m.reservadoPor = null;                         // confirmada
  }
}

interface ResultadoB { vendio: boolean; rechazo: boolean; espero: boolean; }

/** Saga B: lee el stock y decide si le vende al cliente. */
function* sagaQueLee(m: Mundo, usaSemanticLock: boolean, r: ResultadoB): Generator<void> {
  yield;
  if (m.stock > 0) { m.stock -= 1; r.vendio = true; return; }

  // Sin semantic lock, B no tiene forma de saber que ese 0 es TRANSITORIO
  if (!usaSemanticLock) { r.rechazo = true; return; }

  // Con semantic lock, B SABE que hay una saga en curso y puede esperar
  if (m.reservadoPor !== null) {
    r.espero = true;
    for (let i = 0; i < 6; i++) {                  // reintenta unas vueltas
      yield;
      if (m.stock > 0) { m.stock -= 1; r.vendio = true; return; }
    }
  }
  r.rechazo = true;
}

function correrAnomalia1(usaSemanticLock: boolean) {
  let rechazosInnecesarios = 0, ventas = 0, esperas = 0;

  for (let i = 0; i < INTENTOS; i++) {
    const m: Mundo = { stock: 1, reservadoPor: null };    // la ÚLTIMA unidad
    const falla = Math.random() < P_FALLA_COBRO;
    const r: ResultadoB = { vendio: false, rechazo: false, espero: false };

    concurrente([sagaQueCompensa(m, usaSemanticLock, falla), sagaQueLee(m, usaSemanticLock, r)]);

    if (r.vendio) ventas++;
    if (r.espero) esperas++;
    // RECHAZO INNECESARIO: B rechazó, y al final había stock disponible
    if (r.rechazo && m.stock > 0) rechazosInnecesarios++;
  }
  return { rechazosInnecesarios, ventas, esperas };
}

console.log('='.repeat(80));
console.log('  ANOMALÍA 1 — DIRTY READ: rechazar una venta que sí podías hacer');
console.log('='.repeat(80));
console.log(`  ${fmt(INTENTOS)} escenarios · la última unidad de stock · ${P_FALLA_COBRO * 100}% de los cobros falla y compensa\n`);
console.log('  contramedida              ventas de B   rechazos INNECESARIOS   esperó');
console.log('  ' + '-'.repeat(76));

const sinLock = correrAnomalia1(false);
const conLock = correrAnomalia1(true);

console.log(`  ninguna                   ${fmt(sinLock.ventas).padStart(11)}   ${fmt(sinLock.rechazosInnecesarios).padStart(21)}   ${fmt(sinLock.esperas).padStart(6)}  💀`);
console.log(`  semantic lock + reintento ${fmt(conLock.ventas).padStart(11)}   ${fmt(conLock.rechazosInnecesarios).padStart(21)}   ${fmt(conLock.esperas).padStart(6)}  ✅`);

console.log(`
  LO QUE HAY QUE VER

  Sin contramedida, B rechaza ${fmt(sinLock.rechazosInnecesarios)} ventas que SÍ podía hacer
  (${((sinLock.rechazosInnecesarios / INTENTOS) * 100).toFixed(1)}% de los escenarios). El cliente se fue a comprar a otro lado.

  Y el dato que B leyó NO ERA FALSO: la saga A había commiteado de verdad,
  el stock era 0 en ese instante. Lo que pasó es que A compensó después, y B
  ya había tomado su decisión.

  ESO ES UN DIRTY READ, y en una transacción de base de datos no puede
  ocurrir: nadie vería el estado intermedio de A. En una saga, CADA PASO
  COMMITEA, así que el estado intermedio es público.

  EL SEMANTIC LOCK es la contramedida: en vez de dejar el stock en 0 a
  secas, A marca "esta unidad está EN CURSO". B ve la marca, entiende que
  el 0 es transitorio, y espera en lugar de rechazar.

  Y el semantic lock ya lo usás sin saber que tiene nombre: el estado
  PENDIENTE_PAGO de una orden ES un semantic lock. Le está diciendo al
  resto del sistema "esto está en el medio de algo, no asumas nada".

  EL COSTO: B esperó en ${fmt(conLock.esperas)} escenarios. Cambiaste rechazos por
  latencia — y hay que elegir cuánto esperar antes de rendirse.`);

// ===========================================================================
// ANOMALÍA 2 — LOST UPDATE POR COMPENSACIÓN
// ===========================================================================
//
// La más contraintuitiva, y la que rompe implementaciones que "siguieron el
// patrón al pie de la letra".
//
// La compensación clásica es "restaurar el valor anterior". Pero el valor
// anterior se leyó ANTES, y mientras la saga estaba en curso otro lo cambió.
// Restaurarlo PISA un cambio ajeno.

interface Pedido { direccion: string; version: number; }

/** Saga A: cambia la dirección y, si falla, restaura la que había leído. */
function* sagaCambiaDireccion(
  p: Pedido, nueva: string, falla: boolean, compensacionConVersion: boolean,
): Generator<void> {
  const direccionAnterior = p.direccion;          // el "snapshot" para compensar
  const versionAlEscribir = p.version + 1;

  p.direccion = nueva;                             // PASO 1: COMMITEA
  p.version = versionAlEscribir;
  yield;
  yield;                                           // <-- B se mete acá

  if (!falla) return;

  // COMPENSACIÓN
  if (compensacionConVersion) {
    // ✅ Sólo revierto si NADIE escribió después de mí
    if (p.version === versionAlEscribir) {
      p.direccion = direccionAnterior;
      p.version += 1;
    }
    // Si otro escribió, su cambio GANA: no lo piso
  } else {
    // ❌ "Restaurar el valor anterior", sin más
    p.direccion = direccionAnterior;
    p.version += 1;
  }
}

/** Saga B: el cliente corrige la dirección mientras A está en curso. */
function* sagaCorrigeDireccion(p: Pedido, correccion: string): Generator<void> {
  yield;
  p.direccion = correccion;                        // COMMITEA
  p.version += 1;
}

function correrAnomalia2(compensacionConVersion: boolean) {
  let perdidos = 0, correctos = 0;

  for (let i = 0; i < INTENTOS; i++) {
    const p: Pedido = { direccion: 'Calle 1', version: 0 };
    concurrente([
      sagaCambiaDireccion(p, 'Calle 2', true, compensacionConVersion),   // A falla y compensa
      sagaCorrigeDireccion(p, 'Calle 3'),                                 // B corrige
    ]);

    // La corrección del cliente (B) es la que tiene que sobrevivir
    if (p.direccion === 'Calle 3') correctos++;
    else perdidos++;                               // la compensación la pisó
  }
  return { perdidos, correctos };
}

console.log(`\n${'='.repeat(80)}`);
console.log('  ANOMALÍA 2 — LOST UPDATE POR COMPENSACIÓN');
console.log('='.repeat(80));
console.log(`  La saga A cambia la dirección y falla. Mientras estaba en curso, el CLIENTE`);
console.log(`  la corrigió a "Calle 3". A compensa restaurando "Calle 1".\n`);
console.log('  tipo de compensación           corrección del cliente PERDIDA   sobrevivió');
console.log('  ' + '-'.repeat(76));

const ingenua = correrAnomalia2(false);
const conVersion = correrAnomalia2(true);

console.log(`  "restaurar el valor anterior"  ${fmt(ingenua.perdidos).padStart(29)}   ${fmt(ingenua.correctos).padStart(10)}  💀`);
console.log(`  revertir SÓLO si es mi versión ${fmt(conVersion.perdidos).padStart(29)}   ${fmt(conVersion.correctos).padStart(10)}  ✅`);

console.log(`
  ACÁ ESTÁ LA PARTE QUE SORPRENDE.

  La compensación "restaurar el valor anterior" es LA forma en que casi todos
  los tutoriales explican las compensaciones. Y pisa el cambio del cliente en
  ${((ingenua.perdidos / INTENTOS) * 100).toFixed(0)}% de los casos: queda "Calle 1", que NADIE pidió.

  El paquete se manda a una dirección vieja, el cliente jura que la corrigió,
  y en los logs está todo bien: A compensó correctamente según su código.

  POR QUÉ PASA: el "valor anterior" se leyó al EMPEZAR la saga. Durante los
  segundos o minutos que la saga estuvo en curso, el mundo cambió. Restaurar
  un snapshot viejo es, literalmente, un lost update — el mismo del módulo 05,
  disfrazado de compensación.

  LA REGLA QUE SE LLEVA UNO DE ACÁ:

     UNA COMPENSACIÓN NO ES "RESTAURAR EL ESTADO ANTERIOR".
     ES UNA OPERACIÓN DE NEGOCIO QUE DESHACE **MI** EFECTO, Y SÓLO EL MÍO.

  Las tres formas de hacerlo bien:

   1. CHEQUEO DE VERSIÓN (lo de arriba): revierto sólo si nadie escribió
      después de mí. Si alguien escribió, su cambio gana. Es el lock
      optimista del módulo 05 aplicado a la compensación.

   2. OPERACIONES CONMUTATIVAS: si el paso fue "stock = stock - 1", la
      compensación es "stock = stock + 1", y el orden NO IMPORTA. Es la
      contramedida más limpia y la que conviene buscar primero.
      Comparalo con "stock = 9" / "stock = 10", donde el orden lo es todo.

   3. COMPENSACIÓN SEMÁNTICA: en vez de restaurar, emitir un hecho nuevo.
      No "el saldo vuelve a 500" sino "se acreditan 50 por reverso de la
      operación X". Así la compensación es un evento más y no pisa nada.
      Es, además, lo que contabilidad necesita.

  Y el corolario, que vale para todo el módulo: una compensación NO es un
  rollback. El usuario ya vio el efecto; la compensación es un HECHO NUEVO.
  Diseñar una saga es decidir qué le contás al usuario en cada rama.
`);

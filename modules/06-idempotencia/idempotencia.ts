/**
 * Módulo 06 — Cinco implementaciones de idempotencia, y cuál sobrevive.
 *
 *   node modules/06-idempotencia/idempotencia.ts
 *
 * Un cliente hace POST /pagos. A veces la respuesta se pierde y reintenta
 * (reintento SECUENCIAL). A veces el timeout es agresivo y reintenta mientras
 * la primera todavía se está procesando (reintento CONCURRENTE). Y a veces el
 * pod se muere justo después de cobrar y antes de commitear.
 *
 * Cada uno de esos tres casos rompe una implementación distinta. Por eso hacen
 * falta las cinco filas para entender el tema.
 */

const INTENCIONES = 200_000;      // intenciones de pago distintas
const MONTO_USD = 85;

const P_RESPUESTA_PERDIDA = 0.02; // 2%: procesó bien, el cliente no vio la respuesta
const P_REINTENTO_CONCURRENTE = 0.01; // 1%: el cliente reintenta con la primera en vuelo
const P_MUERTE_POST_EFECTO = 0.004;   // 0,4%: el pod muere entre cobrar y commitear

// ---------------------------------------------------------------------------
// El mundo compartido
// ---------------------------------------------------------------------------
interface Mundo {
  claves: Map<string, 'IN_PROGRESS' | 'COMPLETED'>;
  cobros: number;                    // cuántas veces se ejecutó el cobro REAL
  clavesDelProveedor: Set<string>;   // si el proveedor deduplica del otro lado
}

const nuevoMundo = (): Mundo => ({ claves: new Map(), cobros: 0, clavesDelProveedor: new Set() });

/** Cobrar en el proveedor externo. `claveProveedor` = dedup del otro lado. */
function cobrar(m: Mundo, claveProveedor?: string): void {
  if (claveProveedor) {
    if (m.clavesDelProveedor.has(claveProveedor)) return;   // el proveedor deduplica
    m.clavesDelProveedor.add(claveProveedor);
  }
  m.cobros += 1;
}

// ---------------------------------------------------------------------------
// Las cinco implementaciones (cada 'yield' = punto donde otra request se mete)
// ---------------------------------------------------------------------------

/** 1. Sin ninguna protección. */
function* sinProteccion(m: Mundo, clave: string): Generator<void> {
  yield;
  cobrar(m);
}

/** 2. SELECT y después INSERT. Lo que se escribe por reflejo. */
function* selectLuegoInsert(m: Mundo, clave: string): Generator<void> {
  const existe = m.claves.has(clave);          // SELECT
  yield;                                        // <-- LA VENTANA DE LA CARRERA
  if (existe) return;
  cobrar(m);
  m.claves.set(clave, 'COMPLETED');             // INSERT
}

/** 3. UNIQUE + ON CONFLICT, con el efecto en la MISMA transacción (interno). */
function* uniqueEfectoInterno(m: Mundo, clave: string): Generator<void> {
  // INSERT ... ON CONFLICT DO NOTHING: chequear y escribir es UNA operación,
  // serializada por el índice único. No hay yield en el medio: eso es el punto.
  if (m.claves.has(clave)) return;
  m.claves.set(clave, 'IN_PROGRESS');
  yield;
  cobrar(m);                                    // efecto + marca commitean juntos
  m.claves.set(clave, 'COMPLETED');
}

/** 4. UNIQUE, pero el efecto es EXTERNO y el proveedor no deduplica. */
function* uniqueEfectoExterno(m: Mundo, clave: string, muere: boolean): Generator<void> {
  if (m.claves.has(clave)) return;
  m.claves.set(clave, 'IN_PROGRESS');
  yield;
  cobrar(m);                                    // <- ya salió la plata
  if (muere) { m.claves.delete(clave); return; } // 💥 muere antes de commitear:
                                                 //    la marca se revierte con
                                                 //    la transacción, el cobro NO
  m.claves.set(clave, 'COMPLETED');
}

/** 5. Igual, pero con clave DETERMINÍSTICA hacia el proveedor. */
function* uniqueClaveProveedor(m: Mundo, clave: string, muere: boolean): Generator<void> {
  if (m.claves.has(clave)) return;
  m.claves.set(clave, 'IN_PROGRESS');
  yield;
  cobrar(m, clave);                             // el proveedor deduplica por clave
  if (muere) { m.claves.delete(clave); return; }
  m.claves.set(clave, 'COMPLETED');
}

// ---------------------------------------------------------------------------
// El planificador: interleava los intentos concurrentes
// ---------------------------------------------------------------------------
function correrConcurrente(gens: Generator<void>[]): void {
  const vivos = gens.map((g) => ({ g, fin: false }));
  let quedan = vivos.length;
  while (quedan > 0) {
    const t = vivos[Math.floor(Math.random() * vivos.length)];
    if (t.fin) continue;
    if (t.g.next().done) { t.fin = true; quedan--; }
  }
}

type Fabrica = (m: Mundo, clave: string, muere: boolean) => Generator<void>;

function simular(fabrica: Fabrica): { cobros: number; duplicados: number } {
  const m = nuevoMundo();

  for (let i = 0; i < INTENCIONES; i++) {
    const clave = `pago-${i}`;
    const concurrente = Math.random() < P_REINTENTO_CONCURRENTE;
    const respuestaPerdida = Math.random() < P_RESPUESTA_PERDIDA;
    const muere = Math.random() < P_MUERTE_POST_EFECTO;

    if (concurrente) {
      // Dos requests con la misma clave, en vuelo al mismo tiempo
      correrConcurrente([fabrica(m, clave, muere), fabrica(m, clave, false)]);
    } else {
      correrConcurrente([fabrica(m, clave, muere)]);
    }

    if (respuestaPerdida) {
      // El cliente no vio la respuesta y reintenta DESPUÉS, con la misma clave
      correrConcurrente([fabrica(m, clave, false)]);
    }
  }

  return { cobros: m.cobros, duplicados: m.cobros - INTENCIONES };
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------
const fmt = (n: number) => n.toLocaleString('es-AR');

const IMPLEMENTACIONES: [string, Fabrica][] = [
  ['1. sin protección', (m, k) => sinProteccion(m, k)],
  ['2. SELECT y después INSERT', (m, k) => selectLuegoInsert(m, k)],
  ['3. UNIQUE, efecto interno', (m, k) => uniqueEfectoInterno(m, k)],
  ['4. UNIQUE, efecto externo', (m, k, d) => uniqueEfectoExterno(m, k, d)],
  ['5. UNIQUE + clave al proveedor', (m, k, d) => uniqueClaveProveedor(m, k, d)],
];

console.log('='.repeat(82));
console.log(`  ${fmt(INTENCIONES)} intenciones de pago de USD ${MONTO_USD}`);
console.log('='.repeat(82));
console.log(`  ${(P_RESPUESTA_PERDIDA * 100).toFixed(0)} % de las respuestas se pierden  -> el cliente reintenta DESPUÉS`);
console.log(`  ${(P_REINTENTO_CONCURRENTE * 100).toFixed(0)} % reintenta con la primera EN VUELO -> dos requests con la misma clave`);
console.log(`  ${(P_MUERTE_POST_EFECTO * 100).toFixed(1)} % el pod muere entre cobrar y commitear\n`);
console.log('  implementación                     cobros      duplicados    USD cobrados de más');
console.log('  ' + '-'.repeat(80));

for (const [nombre, fab] of IMPLEMENTACIONES) {
  const r = simular(fab);
  const icono = r.duplicados === 0 ? '✅' : r.duplicados < 2_000 ? '⚠️ ' : '💀';
  console.log(
    `  ${nombre.padEnd(33)} ${fmt(r.cobros).padStart(9)}    ${fmt(r.duplicados).padStart(10)}    ` +
      `$${fmt(r.duplicados * MONTO_USD).padStart(12)}  ${icono}`,
  );
}

console.log(`
  QUÉ ROMPE A CADA UNA

  1. SIN PROTECCIÓN. Duplica en los tres escenarios. Cada respuesta perdida
     es un cobro repetido. Es el caso base y da la escala del problema.

  2. SELECT Y DESPUÉS INSERT. Resuelve el reintento SECUENCIAL —cuando la
     primera ya commiteó, el SELECT la encuentra— y por eso parece que
     funciona: en desarrollo, y en producción con poca carga, anda perfecto.
     Falla sólo cuando las dos requests están EN VUELO al mismo tiempo, que
     es el 1% de los casos... y ese 1% son miles de cobros duplicados.
     Es exactamente el lost update del módulo 05 con otra ropa: una decisión
     tomada sobre una lectura que dejó de ser cierta.

  3. UNIQUE + ON CONFLICT, CON EL EFECTO EN LA MISMA TRANSACCIÓN. Correcta.
     Chequear y escribir son UNA operación, serializada por el índice único
     POR DEBAJO del nivel de aislamiento. O quedan la marca y el efecto, o no
     queda ninguno.

  4. UNIQUE, PERO EL EFECTO ES EXTERNO. Acá está la sorpresa del script.
     El UNIQUE es impecable y aun así hay duplicados: cuando el pod muere
     entre cobrar y commitear, la transacción se revierte —y con ella la
     marca de idempotencia— pero LA PLATA YA SALIÓ. Al reintentar, la clave
     no existe y se cobra de nuevo.

     No hay ninguna transacción que abarque tu base y Stripe. Es el mismo
     problema de la doble escritura del módulo 02, del otro lado del tubo.

     Son pocos casos, y ahí está la trampa: es tan raro que no aparece en
     ningún test, nadie lo cree posible, y cuando el cliente reclama un
     cobro duplicado NO FIGURA EN NINGÚN LOG — porque la transacción que
     lo habría registrado es justamente la que se revirtió.

  5. UNIQUE + CLAVE DETERMINÍSTICA HACIA EL PROVEEDOR. La única completa.
     El proveedor deduplica de SU lado, así que el segundo cobro no ocurre
     aunque tu marca se haya perdido.

     Y ojo con "determinística": la clave tiene que derivarse del negocio
     ('order-\${orderId}-charge'), no ser un uuid() nuevo por intento. Un
     interceptor de reintentos que genera una clave nueva en cada intento
     anula toda la protección — y es el bug más común de esta sección.

  LO QUE HAY QUE LLEVARSE

     La idempotencia no es una propiedad de tu endpoint: es una propiedad
     DE PUNTA A PUNTA. Una cadena de cuatro saltos con tres idempotentes
     y uno que no, no es idempotente.

     Y si el proveedor NO soporta claves de idempotencia, el patrón es
     registrar la intención antes de ejecutar y consultarle al proveedor
     antes de reintentar a ciegas (README §5). Menos elegante, igual de
     necesario.
`);

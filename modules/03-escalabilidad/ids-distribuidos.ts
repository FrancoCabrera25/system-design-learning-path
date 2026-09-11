/**
 * Módulo 03 — UUIDv4 vs ULID: qué le hace cada uno a tu índice.
 *
 *   node modules/03-escalabilidad/ids-distribuidos.ts
 *
 * "Los dos son 128 bits y los dos son únicos, da igual cuál uses."
 * Da igual hasta que la tabla tiene 50 millones de filas.
 *
 * Simulamos el nivel hoja de un índice B-tree (el que usan Postgres, MySQL
 * y prácticamente todo motor relacional) y contamos:
 *   - page splits: cuántas veces hubo que partir una página al insertar
 *   - páginas totales y factor de llenado: cuánto ocupa el índice en disco
 *   - working set: cuántas páginas distintas se tocan seguido (si no entran
 *     en memoria, cada INSERT es un viaje al disco)
 */

const N_INSERTS = 200_000;
const CLAVES_POR_PAGINA = 100;      // ~8 KB de página / ~80 bytes por entrada

// ---------------------------------------------------------------------------
// Generadores de ID
// ---------------------------------------------------------------------------

/** UUIDv4: 122 bits aleatorios. Sin ningún orden. */
function uuidV4(): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * ULID / UUIDv7: los primeros 48 bits son el timestamp en milisegundos,
 * el resto es aleatorio. Se ordenan lexicográficamente por tiempo.
 */
let relojFalso = Date.now();
function ulid(): string {
  relojFalso += Math.random() < 0.3 ? 1 : 0;   // ~3 inserts por milisegundo
  const ts = relojFalso.toString(16).padStart(12, '0');
  const hex = '0123456789abcdef';
  let rnd = '';
  for (let i = 0; i < 20; i++) rnd += hex[Math.floor(Math.random() * 16)];
  return ts + rnd;
}

/** BIGSERIAL: el caso ideal, imposible en un sistema shardeado. */
let contador = 0;
const serial = () => (contador++).toString(16).padStart(32, '0');

// ---------------------------------------------------------------------------
// Modelo del nivel hoja de un B-tree
// ---------------------------------------------------------------------------

interface Pagina { claves: string[]; }

interface Stats {
  splits: number;
  paginas: number;
  llenado: number;          // % promedio de ocupación
  workingSet: number;       // páginas distintas tocadas en los últimos 10k inserts
}

function insertarTodo(generar: () => string): Stats {
  // Páginas ordenadas por su primera clave. Mantenemos el orden con búsqueda
  // binaria, igual que el árbol de arriba de un B-tree real.
  const paginas: Pagina[] = [{ claves: [] }];
  let splits = 0;
  const tocadasRecientes: number[] = [];

  for (let i = 0; i < N_INSERTS; i++) {
    const clave = generar();

    // ¿En qué página va? La última cuya primera clave sea <= la nueva.
    let lo = 0, hi = paginas.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const primera = paginas[mid].claves[0];
      if (primera !== undefined && primera <= clave) lo = mid; else hi = mid - 1;
    }
    const idx = lo;
    const pagina = paginas[idx];

    if (pagina.claves.length >= CLAVES_POR_PAGINA) {
      splits++;
      // Postgres e InnoDB detectan cuando estás insertando en la página más
      // a la derecha del índice y parten 90/10 en vez de 50/50, asumiendo
      // que van a seguir llegando claves crecientes. Con IDs ordenados por
      // tiempo esa heurística acierta siempre y las páginas quedan llenas;
      // con IDs aleatorios nunca se activa y todo split es 50/50, dejando
      // dos páginas a media capacidad.
      const esUltima = idx === paginas.length - 1;
      const corte = esUltima
        ? Math.floor(CLAVES_POR_PAGINA * 0.9)
        : CLAVES_POR_PAGINA >> 1;

      const arriba = pagina.claves.splice(corte);
      paginas.splice(idx + 1, 0, { claves: arriba });
      const destino = clave >= arriba[0] ? paginas[idx + 1] : pagina;
      destino.claves.push(clave);
      destino.claves.sort();
    } else {
      pagina.claves.push(clave);
      pagina.claves.sort();
    }

    tocadasRecientes.push(idx);
    if (tocadasRecientes.length > 10_000) tocadasRecientes.shift();
  }

  const totalClaves = paginas.reduce((a, p) => a + p.claves.length, 0);
  return {
    splits,
    paginas: paginas.length,
    llenado: (totalClaves / (paginas.length * CLAVES_POR_PAGINA)) * 100,
    workingSet: new Set(tocadasRecientes).size,
  };
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

const CASOS: [string, () => string][] = [
  ['BIGSERIAL (ideal)', serial],
  ['ULID / UUIDv7', ulid],
  ['UUIDv4 (random)', uuidV4],
];

console.log('='.repeat(76));
console.log(`  ${N_INSERTS.toLocaleString('es-AR')} INSERTs en un índice B-tree (${CLAVES_POR_PAGINA} claves por página de 8 KB)`);
console.log('='.repeat(76));
console.log('\n  tipo de ID            page splits   páginas   llenado   working set (10k)');
console.log('  ' + '-'.repeat(72));

const resultados: Record<string, Stats> = {};
for (const [nombre, gen] of CASOS) {
  const st = insertarTodo(gen);
  resultados[nombre] = st;
  console.log(
    `  ${nombre.padEnd(22)} ${st.splits.toLocaleString('es-AR').padStart(9)}   ` +
      `${st.paginas.toLocaleString('es-AR').padStart(7)}   ${st.llenado.toFixed(0).padStart(5)} %   ` +
      `${st.workingSet.toLocaleString('es-AR').padStart(10)} páginas`,
  );
}

const ulidSt = resultados['ULID / UUIDv7'];
const uuidSt = resultados['UUIDv4 (random)'];
const kbPorPagina = 8;

console.log(`
  CÓMO LEER ESTO

  PAGE SPLITS. Partir una página no es gratis: hay que leerla, crear otra,
  mover la mitad de las entradas, actualizar los punteros del nivel de
  arriba y escribir todo al WAL. UUIDv4 hizo ${(uuidSt.splits / Math.max(ulidSt.splits, 1)).toFixed(1)}x más splits que ULID.

  LLENADO. Cada split 50/50 deja dos páginas a media capacidad. Por eso
  UUIDv4 termina con ${uuidSt.llenado.toFixed(0)}% de llenado contra ${ulidSt.llenado.toFixed(0)}% de ULID: el mismo dato
  ocupa ${((uuidSt.paginas / ulidSt.paginas - 1) * 100).toFixed(0)}% más de índice en disco.

     índice con ULID    ${((ulidSt.paginas * kbPorPagina) / 1024).toFixed(1)} MB
     índice con UUIDv4  ${((uuidSt.paginas * kbPorPagina) / 1024).toFixed(1)} MB

  Y ese índice más grande se paga en cada lectura, en cada backup y en
  cada byte de RAM del buffer pool.

  WORKING SET — el número que más duele. Es cuántas páginas distintas se
  tocaron en los últimos 10.000 inserts:

     ULID:    ${ulidSt.workingSet} páginas (${((ulidSt.workingSet * kbPorPagina) / 1024).toFixed(1)} MB) — entra en la caché de cualquier cosa
     UUIDv4:  ${uuidSt.workingSet.toLocaleString('es-AR')} páginas (${((uuidSt.workingSet * kbPorPagina) / 1024).toFixed(1)} MB) — y crece con la tabla

  Con ULID todos los inserts caen en las últimas páginas, que están
  calientes en memoria. Con UUIDv4 cada insert cae en una página al azar
  de TODO el índice. Mientras el índice entre en RAM no se nota nada.
  El día que el índice supera la memoria disponible, cada INSERT pasa a
  ser una lectura aleatoria de disco y el throughput de escritura se cae
  por un precipicio.

  ESE es el bug: no se manifiesta en desarrollo, ni en staging, ni el
  primer año. Aparece de golpe cuando la tabla cruza un umbral.

  CUÁNDO USAR CADA UNO

    ULID / UUIDv7  -> por defecto. Único sin coordinación, ordenado por
                      tiempo, buena localidad. Postgres 18 trae uuidv7()
                      nativo; antes de eso, la librería 'ulid' o 'uuid'.
    UUIDv4         -> cuando el ID NO debe filtrar información. Un ID
                      ordenado por tiempo le dice a un competidor cuántas
                      órdenes procesás por hora, y permite enumerar
                      recursos. Si el ID es público, esto importa.
    Snowflake      -> 64 bits en vez de 128 (la mitad de índice) y ordenado,
                      pero necesita asignar un machine-id único a cada
                      proceso. Vale la pena a escalas muy grandes.
    BIGSERIAL      -> perfecto mientras haya UNA sola base. Se rompe en
                      cuanto shardeás o necesitás generar el ID antes de
                      escribir (por ejemplo, para la clave de idempotencia).

  TRUCO DE ENTREVISTA: si te preguntan "¿UUID o autoincremental?", la
  respuesta que se espera es sobre unicidad distribuida. La que impresiona
  es "depende de si necesito localidad en el índice — y ahí UUIDv4 y
  UUIDv7 se comportan de forma completamente distinta, aunque los dos
  sean UUIDs de 128 bits".
`);

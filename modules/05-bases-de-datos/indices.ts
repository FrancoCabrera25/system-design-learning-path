/**
 * Módulo 05 — Índices: cuándo el planner los usa y cuándo agregarlos te hunde.
 *
 *   node modules/05-bases-de-datos/indices.ts
 *
 * Dos preguntas que se responden con el mismo modelo de costos que usa
 * Postgres por dentro:
 *   A) ¿Por qué mi query NO usa el índice que le creé?
 *   B) ¿Por qué agregar índices puede hacer más lenta la aplicación?
 */

const FILAS = 10_000_000;
const FILAS_POR_PAGINA = 50;          // filas de ~160 bytes en páginas de 8 KB
const ENTRADAS_POR_PAGINA_IDX = 200;  // entradas de índice, más chicas

// Los mismos parámetros que trae Postgres por defecto:
const SEQ_PAGE_COST = 1;              // leer una página EN ORDEN
const RANDOM_PAGE_COST = 4;           // leer una página SALTEADA (4x más caro)

const PAGINAS_TABLA = Math.ceil(FILAS / FILAS_POR_PAGINA);

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// A) Selectividad: el punto donde el índice deja de convenir
// ---------------------------------------------------------------------------

function costoSeqScan(): number {
  return PAGINAS_TABLA * SEQ_PAGE_COST;
}

function costoIndexScan(filasQueMatchean: number): number {
  const paginasIndice = Math.ceil(filasQueMatchean / ENTRADAS_POR_PAGINA_IDX) + 4; // +4 niveles
  // Cada fila que matchea puede estar en una página distinta de la tabla,
  // y se lee SALTEADA. Como mucho, terminás leyendo toda la tabla.
  const saltosAlHeap = Math.min(filasQueMatchean, PAGINAS_TABLA);
  return paginasIndice * RANDOM_PAGE_COST + saltosAlHeap * RANDOM_PAGE_COST;
}

function costoIndexOnlyScan(filasQueMatchean: number): number {
  // No toca la tabla: todo lo que la query pide está en el índice.
  const paginasIndice = Math.ceil(filasQueMatchean / ENTRADAS_POR_PAGINA_IDX) + 4;
  return paginasIndice * RANDOM_PAGE_COST;
}

console.log('='.repeat(80));
console.log(`  A) ¿POR QUÉ NO USA MI ÍNDICE? — tabla de ${fmt(FILAS)} filas (${fmt(PAGINAS_TABLA)} páginas)`);
console.log('='.repeat(80));
console.log('\n  selectividad     filas      Seq Scan   Index Scan   Index Only   el planner elige');
console.log('  ' + '-'.repeat(78));

const SELECTIVIDADES = [0.0000001, 0.000001, 0.00001, 0.0001, 0.001, 0.005, 0.01, 0.05, 0.2, 0.5, 0.9];

let crucePct = 0;
for (const sel of SELECTIVIDADES) {
  const filas = Math.max(1, Math.round(FILAS * sel));
  const seq = costoSeqScan();
  const idx = costoIndexScan(filas);
  const only = costoIndexOnlyScan(filas);

  const ganaIndice = idx < seq;
  if (!ganaIndice && crucePct === 0) crucePct = sel * 100;

  const elige = ganaIndice ? '✅ Index Scan' : '❌ Seq Scan (¡y hace bien!)';
  console.log(
    `  ${(sel * 100).toFixed(5).padStart(9)} %  ${fmt(filas).padStart(10)}  ` +
      `${fmt(seq).padStart(10)}  ${fmt(idx).padStart(11)}  ${fmt(only).padStart(11)}   ${elige}`,
  );
}

console.log(`
  EL CRUCE ESTÁ CERCA DEL ${crucePct.toFixed(1)} % DE LAS FILAS.

  Por encima de eso, el índice es MÁS LENTO que leer la tabla entera, y el
  planner lo ignora — correctamente. El motivo está en las constantes:
  cada fila encontrada por el índice obliga a un salto ALEATORIO a la
  tabla (${RANDOM_PAGE_COST}x el costo de una lectura secuencial). Cuando hay muchas filas,
  esos saltos cuestan más que barrer todo en orden.

  CONSECUENCIA PRÁCTICA: un índice sobre una columna de BAJA CARDINALIDAD
  —estado, tipo, un booleano, "activo"— casi nunca se usa. Ocupa espacio,
  hace más lentas todas las escrituras (sección B) y no lo usa nadie.

  Si igual necesitás filtrar por ahí, la salida es el ÍNDICE PARCIAL:

      CREATE INDEX ON ordenes (created_at) WHERE estado = 'PENDIENTE';

  Sólo indexa las filas pendientes, que son pocas. Vuelve a ser selectivo.

  Y mirá la columna INDEX ONLY: es entre 2 y 100 veces más barata que el
  Index Scan, porque NO TOCA LA TABLA. Se consigue metiendo en el índice
  todas las columnas que la query pide:

      CREATE INDEX ON ordenes (tenant_id, created_at) INCLUDE (estado, total);

  Es la optimización de lectura con mejor relación costo/beneficio que
  existe, y casi nadie la usa.`);

// ---------------------------------------------------------------------------
// B) Lo que cada índice le cuesta a las escrituras
// ---------------------------------------------------------------------------

const PROB_SPLIT = 0.02;   // probabilidad de que el insert parta una página

console.log(`\n${'='.repeat(80)}`);
console.log('  B) LO QUE CADA ÍNDICE LE COBRA A CADA INSERT');
console.log('='.repeat(80));
console.log('\n  índices   escrituras por INSERT   throughput relativo   INSERTs/s (si con 0 son 20.000)');
console.log('  ' + '-'.repeat(78));

const base = 1;
for (const k of [0, 1, 2, 3, 5, 8, 12]) {
  // 1 escritura al heap + una por índice, más el costo esperado de los splits
  const escrituras = 1 + k * (1 + PROB_SPLIT * 2);
  const rel = base / escrituras;
  const marca = k >= 8 ? '  💀' : k >= 5 ? '  ⚠️ ' : '';
  console.log(
    `  ${String(k).padStart(7)}   ${escrituras.toFixed(2).padStart(21)}   ${(rel * 100).toFixed(0).padStart(18)} %   ` +
      `${fmt(20_000 * rel).padStart(10)}${marca}`,
  );
}

console.log(`
  Cada índice de más es una escritura de más en CADA insert, update y
  delete de esa tabla. Con 8 índices, un INSERT son 9 escrituras: el
  throughput de escritura cae a menos de la mitad.

  Y hay tres costos más que no están en esta tabla:

   1. MEMORIA. Los índices compiten con los datos por el buffer pool. Un
      índice que nadie usa DESALOJA páginas que sí se usaban, y eso
      degrada queries que no tienen nada que ver con él (módulo 03, B4).
   2. EL PLANNER. Con muchos índices parecidos, a veces elige mal.
   3. EL BLOQUEO AL CREARLO. 'CREATE INDEX' bloquea las escrituras de la
      tabla entera. En producción SIEMPRE 'CREATE INDEX CONCURRENTLY'
      (tarda más y puede dejar un índice inválido si falla — hay que
      chequear pg_index.indisvalid después).

  CÓMO ENCONTRAR LOS ÍNDICES QUE NO SIRVEN:

      SELECT schemaname, relname, indexrelname, idx_scan,
             pg_size_pretty(pg_relation_size(indexrelid))
      FROM pg_stat_user_indexes
      WHERE idx_scan < 50          -- casi nunca se usó
      ORDER BY pg_relation_size(indexrelid) DESC;

  En cualquier base con unos años encima, esa query devuelve varios
  gigabytes de índices que sólo están haciendo más lentas las escrituras.
  (Ojo: mirá las estadísticas desde el último reset, y acordate de los
  índices que sostienen un UNIQUE o una FK — ésos no se tocan aunque
  idx_scan sea 0.)
`);

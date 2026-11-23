/**
 * Módulo 09 — Los dos costos de event sourcing que no se ven el día 1.
 *
 *   node modules/09-datos-distribuidos/event-sourcing.ts
 *
 * El día 1 event sourcing es hermoso: append-only, auditoría gratis,
 * optimistic lock gratis, "viajar en el tiempo".
 *
 * Los dos costos aparecen después:
 *   A) cargar un agregado cuesta O(cantidad de eventos de su stream)
 *   B) el esquema de los eventos cambia, y los viejos no se pueden tocar
 */

// --- Modelo de costo (medido a ojo sobre Postgres, pero los ÓRDENES son reales)
const MS_PLAN_Y_SEEK = 0.8;       // planear + bajar por el índice (stream_id, version)
const MS_POR_FILA = 0.012;        // traer una fila del event store
const MS_DESERIALIZAR = 0.018;    // JSON.parse + validar + aplicar() al agregado
const MS_SNAPSHOT = 0.8 + 0.25;   // seek + deserializar un blob más grande
const MS_POR_UPCASTER = 0.004;    // un salto de versión de esquema sobre un evento

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

function msAHumano(ms: number): string {
  if (ms < 1_000) return `${fmt(ms, 1)} ms`;
  if (ms < 60_000) return `${fmt(ms / 1_000, 1)} s`;
  if (ms < 3_600_000) return `${fmt(ms / 60_000, 1)} min`;
  return `${fmt(ms / 3_600_000, 1)} h`;
}

/** Cargar un agregado leyendo TODOS sus eventos. */
function costoSinSnapshot(eventos: number): number {
  return MS_PLAN_Y_SEEK + eventos * (MS_POR_FILA + MS_DESERIALIZAR);
}

/**
 * Con snapshot cada K eventos: leés el snapshot más nuevo y sólo la cola.
 * En promedio la cola mide K/2; en el peor caso, K.
 */
function costoConSnapshot(eventos: number, k: number, peorCaso = false): number {
  if (eventos < k) return costoSinSnapshot(eventos);
  const cola = peorCaso ? k : k / 2;
  return MS_SNAPSHOT + cola * (MS_POR_FILA + MS_DESERIALIZAR);
}

// ---------------------------------------------------------------------------
// A) El costo de cargar un agregado
// ---------------------------------------------------------------------------
console.log('='.repeat(84));
console.log('  A) CARGAR UN AGREGADO ES O(EVENTOS DEL STREAM)');
console.log('='.repeat(84));

const AGREGADOS: [string, number][] = [
  ['Usuario (registro, login, perfil)', 40],
  ['Pedido (del carrito a la entrega)', 220],
  ['Cuenta corriente, 1 año', 3_500],
  ['Cuenta corriente, 5 años', 18_000],
  ['Libro mayor de un comercio grande', 400_000],
  ['Stream de un sensor IoT', 5_000_000],
];

console.log('\n  agregado                               eventos    sin snapshot    cada 500    cada 100');
console.log('  ' + '-'.repeat(80));
for (const [nombre, n] of AGREGADOS) {
  console.log(
    `  ${nombre.padEnd(36)} ${fmt(n).padStart(10)}  ` +
      `${msAHumano(costoSinSnapshot(n)).padStart(13)}  ` +
      `${msAHumano(costoConSnapshot(n, 500)).padStart(10)}  ` +
      `${msAHumano(costoConSnapshot(n, 100)).padStart(10)}`,
  );
}

const LIM = 50; // presupuesto de latencia para cargar el agregado, en ms
const eventosEnPresupuesto = Math.floor((LIM - MS_PLAN_Y_SEEK) / (MS_POR_FILA + MS_DESERIALIZAR));
console.log(`
  LA LÍNEA QUE IMPORTA: con un presupuesto de ${LIM} ms para cargar el agregado
  (porque después todavía tenés que decidir, escribir y responder), entran
  ~${fmt(eventosEnPresupuesto)} eventos por stream. Pasado eso, los snapshots NO son una
  optimización: son parte del diseño.

  Y fijate que un snapshot cada 500 deja el costo CONSTANTE sin importar si
  el stream tiene 3.500 o 5.000.000 de eventos: ${msAHumano(costoConSnapshot(5_000_000, 500))}. Eso es lo que
  hace viable event sourcing en streams largos.

  Peor caso (justo antes del próximo snapshot), cada 500: ${msAHumano(costoConSnapshot(18_000, 500, true))}.
  Por eso el intervalo se elige por el PEOR caso, no por el promedio.`);

// ---------------------------------------------------------------------------
// A2) Lo que un snapshot NO resuelve
// ---------------------------------------------------------------------------
const EVENTOS_TOTALES = 80_000_000;
const costoRebuild = MS_PLAN_Y_SEEK + EVENTOS_TOTALES * (MS_POR_FILA + MS_DESERIALIZAR);

console.log(`\n${'='.repeat(84)}`);
console.log('  A2) LO QUE UN SNAPSHOT NO RESUELVE: RECONSTRUIR UNA PROYECCIÓN');
console.log('='.repeat(84));
console.log(`
  Reconstruir una proyección (el modelo de lectura de CQRS) significa leer
  TODO el historial, de todos los streams, en orden. Los snapshots por
  agregado no sirven: la proyección cruza agregados.

      ${fmt(EVENTOS_TOTALES)} eventos  ->  ${msAHumano(costoRebuild)} de una sola pasada, un worker

  Eso es un número de PLANIFICACIÓN, no un detalle: define cuánto tarda en
  volver un modelo de lectura después de un bug en la proyección. Es la
  causa del p99.9 de minutos que ves en cqrs-lag.ts: durante una
  reconstrucción, el lag de la proyección ES el tiempo que falta para
  terminarla.

  Y es por qué las proyecciones se reconstruyen EN PARALELO Y EN VERDE:
  armás la proyección nueva al lado, la dejás alcanzar la punta del log, y
  recién ahí cambiás a qué tabla lee la query. Nunca truncando la tabla que
  está sirviendo tráfico.`);

// ---------------------------------------------------------------------------
// B) El costo que de verdad te muerde: el versionado de eventos
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(84)}`);
console.log('  B) EL COSTO REAL: LA CADENA DE UPCASTERS');
console.log('='.repeat(84));

const CAMBIOS_POR_ANIO = 2;          // "renombramos un campo", "partimos un evento en dos"
const EVENTOS_POR_ANIO = 16_000_000;
const ANIOS = 6;

console.log(`
  Un evento guardado es inmutable: ya pasó. No podés hacerle un ALTER TABLE
  a la historia. Entonces cuando el esquema de un evento cambia, el código
  que lo LEE tiene que entender todas las versiones que existieron.

  Eso es un upcaster: una función v3 -> v4 que se aplica al leer. Y los
  upcasters se APILAN: un evento de 2021 pasa por todos los cambios desde
  2021 hasta hoy, cada vez que alguien lo lee.

  Con ${CAMBIOS_POR_ANIO} cambios de esquema por año y ${fmt(EVENTOS_POR_ANIO)} eventos nuevos por año:
`);
console.log('  año   eventos acumulados   versiones   saltos de upcast   reconstrucción completa      costo unitario');
console.log('  ' + '-'.repeat(80));

let msAnioAnterior = 0;
for (let anio = 1; anio <= ANIOS; anio++) {
  const versiones = 1 + CAMBIOS_POR_ANIO * (anio - 1);
  let eventos = 0;
  let saltos = 0;
  for (let k = 1; k <= anio; k++) {
    eventos += EVENTOS_POR_ANIO;
    // un evento escrito en el año k pasa por los cambios de los años k..anio
    saltos += EVENTOS_POR_ANIO * CAMBIOS_POR_ANIO * (anio - k);
  }
  const ms = eventos * (MS_POR_FILA + MS_DESERIALIZAR) + saltos * MS_POR_UPCASTER;
  const crecimiento = msAnioAnterior ? ` (${fmt(ms / msAnioAnterior, 2)}x vs año ${anio - 1})` : '';
  const usPorEvento = (ms * 1_000) / eventos;
  console.log(
    `  ${String(anio).padEnd(5)} ${fmt(eventos).padStart(17)} ${String(versiones).padStart(11)} ` +
      `${fmt(saltos).padStart(18)}   ${msAHumano(ms).padStart(8)}${crecimiento.padEnd(20)}` +
      `${fmt(usPorEvento, 1).padStart(6)} µs/ev`,
  );
  msAnioAnterior = ms;
}

console.log(`
  Mirá la ÚLTIMA columna: el costo por evento sube año a año. Eso es la
  prueba de que no es sólo "hay más eventos": cada evento individual se
  volvió más caro de leer, porque arrastra más saltos de upcast.

  Por eso el total crece cuadrático y no lineal: cada año agrega eventos Y
  agrega un salto a TODOS los eventos anteriores. Ese es el costo que nadie
  presupuesta el día 1.

  LAS TRES SALIDAS, y las tres tienen costo:

  1. ESCRIBIR LOS UPCASTERS Y VIVIR CON ELLOS.
     Es lo correcto y lo que hace todo el mundo. Pero es código que NUNCA
     se borra y que hay que testear: un upcaster v3->v4 con un bug corrompe
     silenciosamente todos los eventos anteriores a 2022, en todas las
     proyecciones, para siempre.
     -> test obligatorio: un fixture de cada versión histórica del evento.

  2. REESCRIBIR EL LOG ("migración destructiva" / copy-fork).
     Leés el stream viejo, escribís un stream nuevo ya upcasteado, y
     archivás el viejo. Borra toda la cadena de upcasters de un saque.
     PERO: perdés la propiedad de "el log es la verdad inmutable y
     auditable", que era la razón por la que elegiste event sourcing.
     Si tenés requisitos de auditoría o regulatorios, puede no ser opción.

  3. EVENTOS DÉBILMENTE TIPADOS (un JSON abierto, tolerante).
     No hay upcasters porque no hay esquema. Y tampoco hay garantía de que
     el consumidor no explote: cambiaste el contrato por "no tener
     contrato". Es la trampa más tentadora y la peor.

  ⚠️  LA TRAMPA DE LOS SNAPSHOTS, que casi nadie ve venir:

      un snapshot es el resultado de correr aplicar() sobre los eventos
      CON EL CÓDIGO DE ESE MOMENTO.

      Si arreglás un bug en aplicar() — que es exactamente una de las cosas
      que event sourcing promete que podés hacer, porque "recalculás desde
      los eventos" — los snapshots viejos siguen teniendo el estado MAL
      CALCULADO, y el agregado nunca se recalcula desde cero.

      -> todo snapshot guarda la versión del código que lo generó, y al
         leerlo, si la versión no es la actual, se DESCARTA y se recalcula.
         Sin eso, event sourcing no te da la propiedad por la que lo
         elegiste.`);

// ---------------------------------------------------------------------------
// C) Cuándo sí
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(84)}`);
console.log('  C) LA REGLA PARA DECIDIR');
console.log('='.repeat(84));
console.log(`
  Event sourcing vale cuando la HISTORIA ES EL DOMINIO, no un lujo:

    ✅ contabilidad, libro mayor, movimientos de cuenta
       (el saldo ES la suma de los movimientos; ya lo modelabas así)
    ✅ auditoría regulatoria: "quién cambió qué y cuándo" es un requisito
    ✅ máquinas de estado con reversiones y corrección retroactiva
    ✅ dominios donde después vas a querer preguntar algo que hoy no sabés
       que vas a preguntar (el log te deja responderlo; una tabla con
       UPDATE, no)

  Y NO vale cuando:

    ❌ CRUD con auditoría: una tabla de historial o un trigger te dan el
       95% del beneficio por el 5% del costo
    ❌ el equipo no tiene a nadie que ya haya mantenido un event store
       MÁS DE DOS AÑOS (el costo B aparece recién ahí)
    ❌ lo elegís "por si acaso", para un futuro que todavía no existe

  Y la decisión es POR AGREGADO, no por sistema: en el mismo servicio podés
  tener Pago con event sourcing (donde la historia es el dominio) y
  Categoría como un CRUD común. Esa mezcla es lo normal y lo correcto;
  "event sourcing en todo el sistema" es casi siempre un error de alcance.

  Y acordate del orden de adopción del README: outbox -> saga -> CQRS ->
  event sourcing. Event sourcing es el ÚLTIMO, y el único de los cuatro
  que es perfectamente posible que no necesites nunca.
`);

/**
 * Módulo 08 — Reintentos: amplificación en cascada y colapso metaestable.
 *
 *   node modules/08-fiabilidad/amplificacion.ts
 *
 * A) Cuántas requests llegan al servicio más profundo cuando cada capa
 *    reintenta por su cuenta.
 * B) Por qué el sistema NO VUELVE aunque el pico de tráfico ya haya pasado,
 *    y cómo el retry budget corta ese lazo.
 */

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

// ===========================================================================
// A) La amplificación en cascada
// ===========================================================================
console.log('='.repeat(80));
console.log('  A) AMPLIFICACIÓN — "cada capa reintenta 3 veces, ¿cuál es el problema?"');
console.log('='.repeat(80));
console.log('\n   capas   reintentos por capa   requests al servicio MÁS PROFUNDO   amplificación');
console.log('  ' + '-'.repeat(78));

for (const [capas, reintentos] of [[1, 3], [2, 3], [3, 3], [4, 3], [3, 5], [5, 2]] as [number, number][]) {
  const llamadas = Math.pow(reintentos, capas);
  const icono = llamadas > 50 ? '💀' : llamadas > 10 ? '⚠️ ' : '✅';
  console.log(
    `  ${String(capas).padStart(6)}   ${String(reintentos).padStart(19)}   ${fmt(llamadas).padStart(33)}   ` +
      `${fmt(llamadas).padStart(10)}x  ${icono}`,
  );
}

const USUARIOS_SEG = 500;
console.log(`
  LEER ASÍ: con 3 capas que reintentan 3 veces cada una, UNA request del
  usuario se convierte en 27 llamadas al servicio más profundo — que es,
  justamente, el que está caído.

  A ${fmt(USUARIOS_SEG)} requests/s de usuarios reales, el servicio de abajo recibe
  ${fmt(USUARIOS_SEG * 27)} req/s. No se va a recuperar nunca: cada intento de
  recuperarse recibe 27 veces la carga original.

  Y lo peor es que cada capa está "bien programada" por separado. El bug
  no está en ninguna de las tres: está en que nadie miró el total.

  LAS DOS DEFENSAS

  1. REINTENTAR EN UNA SOLA CAPA. Elegí cuál —normalmente la más cercana
     a la dependencia, o el borde— y que las demás propaguen el error.
     Amplificación: 3x en vez de 27x.

  2. RETRY BUDGET. En vez de "3 intentos por request", "los reintentos no
     pueden superar el 10% del tráfico exitoso". Cuando todo está sano
     casi no se usa; cuando todo falla, el presupuesto se agota y los
     reintentos SE APAGAN SOLOS.
     Es lo que hacen Envoy, Finagle y gRPC, y es estrictamente mejor que
     un contador por request — porque el contador por request no sabe
     cuántas otras requests están reintentando al mismo tiempo.`);

// ===========================================================================
// B) El colapso metaestable
// ===========================================================================
const CAPACIDAD = 1_000;          // req/s que el servicio puede atender
const CARGA_NORMAL = 800;         // req/s de usuarios reales
const CARGA_PICO = 1_600;         // durante el pico
const PICO_DESDE = 60, PICO_HASTA = 90;
const TIMEOUT_S = 2;              // el cliente corta a los 2 s
const MAX_INTENTOS = 3;
const DURACION_S = 400;

interface Tick { t: number; ofrecida: number; util: number; desperdiciada: number; cola: number; }

/**
 * La pieza que hace metaestable a este sistema: cuando el cliente llega a su
 * timeout, SE VA y reintenta — pero su request SIGUE EN LA COLA DEL SERVIDOR.
 * El servidor no sabe que el cliente se fue, así que igual la procesa.
 *
 * Esa es la realimentación positiva: cada timeout genera (a) un reintento
 * nuevo y (b) trabajo zombi que consume capacidad sin servirle a nadie.
 *
 * @param budget  tope de reintentos como fracción del trabajo ÚTIL servido.
 *                Infinity = sin presupuesto (lo que hace casi todo el mundo).
 */
function simular(budget: number): { serie: Tick[]; recuperaEn: number | null } {
  // cola[i] = cuántas requests llevan i segundos esperando
  let cola: number[] = [];
  let reintentosProximoTick = 0;
  const serie: Tick[] = [];
  let recuperaEn: number | null = null;

  for (let t = 0; t < DURACION_S; t++) {
    const usuarios = t >= PICO_DESDE && t < PICO_HASTA ? CARGA_PICO : CARGA_NORMAL;
    const ofrecida = usuarios + reintentosProximoTick;

    cola.unshift(ofrecida);                       // llegan con edad 0

    // Los que cumplen el timeout esperando: el CLIENTE se va y reintenta.
    // Su request queda en la cola igual -> se convierte en trabajo zombi.
    const abandonan = cola[TIMEOUT_S] ?? 0;

    // El servidor procesa FIFO, de lo más viejo a lo más nuevo.
    let restante = CAPACIDAD;
    let util = 0, desperdiciada = 0;
    for (let edad = cola.length - 1; edad >= 0 && restante > 0; edad--) {
      const toma = Math.min(cola[edad], restante);
      cola[edad] -= toma;
      restante -= toma;
      if (edad >= TIMEOUT_S) desperdiciada += toma;   // el cliente ya no está
      else util += toma;
    }
    cola = cola.filter((_, i) => i < 60);            // no guardamos más de 60 s

    const techo = budget === Infinity ? Infinity : util * budget;
    reintentosProximoTick = Math.min(abandonan, techo);

    const enCola = cola.reduce((a, b) => a + b, 0);
    serie.push({ t, ofrecida, util, desperdiciada, cola: enCola });

    if (recuperaEn === null && t > PICO_HASTA + 10) {
      const ultimos = serie.slice(-10);
      if (ultimos.every((x) => x.desperdiciada < 1 && x.cola < CAPACIDAD)) recuperaEn = t;
    }
  }
  return { serie, recuperaEn };
}

const sin = simular(Infinity);
const con = simular(0.10);

console.log(`\n${'='.repeat(80)}`);
console.log('  B) EL COLAPSO METAESTABLE — un pico de 30 segundos');
console.log('='.repeat(80));
console.log(`  Capacidad ${fmt(CAPACIDAD)} req/s · carga normal ${fmt(CARGA_NORMAL)} · pico de ${fmt(CARGA_PICO)} entre t=${PICO_DESDE}s y t=${PICO_HASTA}s`);
console.log(`  El pico dura 30 segundos. Mirá qué pasa DESPUÉS de que termina.\n`);
console.log('    t         SIN retry budget                    CON retry budget (10%)');
console.log('          ofrecida  ÚTIL  desperd.  cola      ofrecida  ÚTIL  desperd.  cola');
console.log('  ' + '-'.repeat(76));

for (const t of [30, 75, 89, 95, 120, 250, 399]) {
  const a = sin.serie[t], b = con.serie[t];
  const marca = t === 95 ? '  <-- el pico YA TERMINÓ' : '';
  console.log(
    `  ${String(t).padStart(4)}s  ${fmt(a.ofrecida).padStart(9)} ${fmt(a.util).padStart(5)} ${fmt(a.desperdiciada).padStart(9)} ${fmt(a.cola).padStart(5)}` +
      `     ${fmt(b.ofrecida).padStart(9)} ${fmt(b.util).padStart(5)} ${fmt(b.desperdiciada).padStart(9)} ${fmt(b.cola).padStart(5)}${marca}`,
  );
}

const estado = (r: { recuperaEn: number | null }) =>
  r.recuperaEn === null ? '💀 NO SE RECUPERA' : `✅ recupera en t=${r.recuperaEn}s`;

console.log(`\n  sin retry budget:  ${estado(sin)}`);
console.log(`  con retry budget:  ${estado(con)}`);

console.log(`
  ACÁ ESTÁ EL PUNTO.

  El pico terminó en t=${PICO_HASTA}. La carga de usuarios volvió a ${fmt(CARGA_NORMAL)} req/s,
  MUY por debajo de la capacidad de ${fmt(CAPACIDAD)}. Y sin retry budget el sistema
  sigue sirviendo CERO trabajo útil minutos después.

  Mirá la columna "ÚTIL" contra "desperd.": el servidor sigue a pleno,
  al 100% de capacidad, procesando ${fmt(CAPACIDAD)} req/s... que no le sirven a nadie,
  porque el cliente de cada una se fue hace rato y ya reintentó.

  LA PIEZA QUE LO HACE METAESTABLE, y que casi nadie modela:

     Cuando el cliente llega a su timeout, SE VA. Pero su request SIGUE
     EN LA COLA DEL SERVIDOR, que no se enteró. El servidor la procesa
     igual. Esa capacidad se desperdicia, lo que hace que la siguiente
     también venza, lo que genera otro reintento, lo que llena más la
     cola de trabajo zombi.

     1. El pico satura -> la cola crece
     2. Las requests esperan más que el timeout -> el cliente se va
     3. El cliente reintenta -> entra trabajo NUEVO
     4. Y el servidor sigue masticando el trabajo VIEJO que ya no sirve
     5. El pico desaparece... y el lazo gira solo, alimentado por su
        propia cola

  Eso es un FALLO METAESTABLE: el sistema se queda en el estado malo
  aunque la causa haya desaparecido. No sale solo. Alguien tiene que
  cortar el tráfico, vaciar colas o reiniciar en orden.

  Ya lo vimos tres veces en este path con otros nombres:
    - módulo 04: Redis vuelve VACÍO, la base no puede repoblarlo
    - módulo 07: el loop de rebalances, donde el progreso real es cero
    - módulo 01: la cola que crece cuando la utilización pasa de 1

  EL RETRY BUDGET LO CORTA porque limita los reintentos a una fracción
  del tráfico que SÍ estás pudiendo atender. Si estás atendiendo poco,
  reintentás poco. El lazo de realimentación positiva deja de existir.

  Y es una propiedad del SISTEMA, no de la request: una request
  individual no sabe cuántas otras están reintentando al mismo tiempo.
  Por eso un contador de 3 intentos por request nunca te protege de esto.
`);

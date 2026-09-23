/**
 * Módulo 06 — Por qué un lock distribuido con TTL no garantiza exclusión mutua.
 *
 *   node modules/06-idempotencia/fencing.ts
 *
 * El escenario de Martin Kleppmann, simulado:
 *
 *   Cliente 1 toma el lock (TTL 10 s) ──► PAUSA DE GC DE 15 SEGUNDOS
 *   El lock expira solo a los 10 s
 *   Cliente 2 toma el lock y escribe
 *   Cliente 1 despierta, CREE que sigue teniendo el lock, y escribe
 *   💥 los dos escribieron
 *
 * El cliente 1 no hizo nada mal. Ningún proceso puede saber cuánto tiempo
 * pasó mientras estaba congelado. Ni Redis, ni Redlock, ni etcd cambian eso:
 * el problema no está en cómo se ADQUIERE el lock, sino en lo que pasa DESPUÉS.
 */

const TRABAJOS = 100_000;
const TTL_LOCK_MS = 10_000;
const TRABAJO_NORMAL_MS = 800;

/** Probabilidad de que a un worker le toque una pausa larga durante el trabajo. */
const P_PAUSA = 0.004;   // 0,4%: GC stop-the-world, nodo suspendido, red congelada

/** Duración de esa pausa. En un heap grande, varios segundos es rutina. */
const pausaMs = () => 2_000 + Math.random() * 25_000;

const fmt = (n: number) => n.toLocaleString('es-AR');

// ---------------------------------------------------------------------------
// El recurso protegido (un archivo en S3, una fila, un contador)
// ---------------------------------------------------------------------------
interface Recurso {
  escrituras: number;
  ultimoToken: number;     // sólo se usa con fencing
  corrupciones: number;    // dos escrituras para el mismo trabajo
  rechazadas: number;
}

function escribir(r: Recurso, token: number, usaFencing: boolean, yaEscrito: boolean): boolean {
  if (usaFencing && token <= r.ultimoToken) {
    r.rechazadas += 1;
    return false;                       // 🛡️ escritura vieja: rechazada
  }
  if (usaFencing) r.ultimoToken = token;
  r.escrituras += 1;
  if (yaEscrito) r.corrupciones += 1;   // alguien ya había escrito este trabajo
  return true;
}

// ---------------------------------------------------------------------------
// La simulación
// ---------------------------------------------------------------------------
function simular(usaFencing: boolean): Recurso {
  const r: Recurso = { escrituras: 0, ultimoToken: 0, corrupciones: 0, rechazadas: 0 };
  let tokenGlobal = 0;

  for (let i = 0; i < TRABAJOS; i++) {
    // --- Cliente 1 toma el lock ---
    const token1 = ++tokenGlobal;
    const t0 = 0;
    const pausa = Math.random() < P_PAUSA ? pausaMs() : 0;
    const terminaCliente1 = t0 + TRABAJO_NORMAL_MS + pausa;

    if (terminaCliente1 <= TTL_LOCK_MS) {
      // Caso normal: terminó antes de que expirara el lock
      escribir(r, token1, usaFencing, false);
      continue;
    }

    // --- El lock expiró mientras el cliente 1 estaba congelado ---
    // El cliente 2 lo toma y hace su trabajo (rápido, sin pausa)
    const token2 = ++tokenGlobal;
    escribir(r, token2, usaFencing, false);

    // --- El cliente 1 despierta y escribe, creyendo que tiene el lock ---
    escribir(r, token1, usaFencing, true);
  }

  return r;
}

const sinFencing = simular(false);
const conFencing = simular(true);

console.log('='.repeat(80));
console.log(`  ${fmt(TRABAJOS)} trabajos · lock con TTL de ${TTL_LOCK_MS / 1000} s · trabajo normal de ${TRABAJO_NORMAL_MS} ms`);
console.log('='.repeat(80));
console.log(`  ${(P_PAUSA * 100).toFixed(1)} % de los workers sufre una pausa de 2 a 27 s (GC, suspensión, red).\n`);
console.log('                              escrituras   escrituras dobles   rechazadas por token');
console.log('  ' + '-'.repeat(76));
console.log(
  `  lock con TTL, sin fencing   ${fmt(sinFencing.escrituras).padStart(10)}   ` +
    `${fmt(sinFencing.corrupciones).padStart(17)}   ${fmt(sinFencing.rechazadas).padStart(20)}  💀`,
);
console.log(
  `  lock con TTL + FENCING      ${fmt(conFencing.escrituras).padStart(10)}   ` +
    `${fmt(conFencing.corrupciones).padStart(17)}   ${fmt(conFencing.rechazadas).padStart(20)}  ✅`,
);

console.log(`
  ${fmt(sinFencing.corrupciones)} escrituras dobles sobre ${fmt(TRABAJOS)} trabajos. Con un lock que funcionó
  perfectamente: Redis nunca falló, el TTL nunca se equivocó, nadie escribió
  mal el código. La exclusión mutua se rompió igual.

  POR QUÉ REDLOCK NO ARREGLA ESTO

  Redlock (el algoritmo con N nodos de Redis) hace más robusta la ADQUISICIÓN
  del lock frente a la caída de un nodo. Pero el problema de arriba no es de
  adquisición: el cliente 1 adquirió el lock correctamente. El problema es que
  entre "tengo el lock" y "escribo" pasó tiempo que el cliente NO PUEDE MEDIR.

  Ningún algoritmo de locking resuelve eso, porque la falla no está en el
  lock: está en la suposición de que el tiempo del cliente y el del lock
  avanzan juntos. Con pausas de GC, suspensión de VMs o relojes que saltan,
  no avanzan juntos.

  CÓMO FUNCIONA EL FENCING TOKEN

    Cliente 1 toma el lock  -> token 33   [congelado 15 s]
    Cliente 2 toma el lock  -> token 34   escribe con 34  ✅ (el recurso anota 34)
    Cliente 1 despierta     -> escribe con 33  ❌ RECHAZADO (33 < 34)

  El recurso rechaza cualquier escritura con un token menor al último que vio.
  Y acá está la parte que casi nadie dice:

     EL FENCING NO VIVE EN EL LOCK. VIVE EN EL RECURSO.

  Si tu base de datos, tu bucket o tu API no comparan tokens, no tenés
  fencing — por más que tu librería de locks te devuelva un número.

  EN POSTGRES SE ESCRIBE ASÍ, y ya lo conocés:

      UPDATE recurso SET datos = $1, version = $2
       WHERE id = $3 AND version < $2;

  Es el lock optimista del módulo 05. Fencing token y columna de versión son
  EL MISMO MECANISMO con dos nombres distintos.

  Y el corolario incómodo: si el recurso puede comparar versiones, muchas
  veces YA NO NECESITÁS EL LOCK. La comparación sola te da la corrección; el
  lock queda como optimización para no desperdiciar trabajo.

  LA PREGUNTA QUE HAY QUE HACERSE ANTES DE PONER UN LOCK DISTRIBUIDO

     ¿Es por EFICIENCIA o por CORRECCIÓN?

     Eficiencia -> evitar trabajo repetido. Si falla, se hace dos veces y no
                   pasa nada grave. Redis alcanza. (El single-flight del
                   módulo 04 es esto.)
     Corrección -> si dos lo hacen a la vez se corrompe algo. Un lock
                   distribuido NO ALCANZA, nunca. Necesitás fencing, o una
                   operación atómica en el recurso, o las dos.

  Si la respuesta es "corrección" y tu diseño se apoya sólo en el lock,
  el diseño tiene un bug que va a aparecer el día con más carga del año —
  porque es el día con más pausas de GC.
`);

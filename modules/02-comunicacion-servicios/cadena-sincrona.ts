/**
 * Módulo 02 — Tres arquitecturas para el mismo caso de negocio.
 *
 *   node modules/02-comunicacion-servicios/cadena-sincrona.ts
 *
 * Caso: POST /orders necesita validar stock (A), cobrar (B), reservar envío
 * (C) y notificar (D). Cada servicio tiene 99,9% de disponibilidad y una
 * latencia con cola larga.
 *
 * Simulamos 100.000 órdenes bajo tres diseños y medimos qué se rompe.
 */

const N = 100_000;

interface Servicio {
  nombre: string;
  disponibilidad: number;   // probabilidad de responder OK
  p50: number;              // ms
  colaMs: number;           // cuánto se va a la cola en el 1% peor
  critico: boolean;         // ¿la orden es inválida sin esto?
}

const SERVICIOS: Servicio[] = [
  { nombre: 'A stock',    disponibilidad: 0.999, p50: 25, colaMs: 900,  critico: true  },
  { nombre: 'B cobro',    disponibilidad: 0.999, p50: 80, colaMs: 1500, critico: true  },
  { nombre: 'C envío',    disponibilidad: 0.999, p50: 40, colaMs: 1200, critico: false },
  { nombre: 'D notifica', disponibilidad: 0.999, p50: 30, colaMs: 2000, critico: false },
];

/** Devuelve [ok, latenciaMs] de una llamada al servicio. */
function llamar(s: Servicio): [boolean, number] {
  const ok = Math.random() < s.disponibilidad;
  const lento = Math.random() < 0.01;
  const lat = lento ? s.colaMs * (0.5 + Math.random()) : s.p50 * (0.6 + Math.random() * 0.8);
  return [ok, lat];
}

function percentil(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil((p / 100) * o.length) - 1)];
}

interface Resultado { exitos: number; latencias: number[]; }

function reportar(titulo: string, r: Resultado, nota: string) {
  const disp = (r.exitos / N) * 100;
  const downtimeMin = ((100 - disp) / 100) * 43_200;
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  ${titulo}`);
  console.log('─'.repeat(72));
  console.log(`  disponibilidad efectiva   ${disp.toFixed(3)} %`);
  console.log(`  downtime equivalente      ${downtimeMin.toFixed(0)} min/mes`);
  console.log(`  latencia p50              ${percentil(r.latencias, 50).toFixed(0)} ms`);
  console.log(`  latencia p99              ${percentil(r.latencias, 99).toFixed(0)} ms`);
  console.log(`  latencia p99.9            ${percentil(r.latencias, 99.9).toFixed(0)} ms`);
  console.log(`\n  ${nota}`);
}

// ---------------------------------------------------------------------------
// DISEÑO 1 — Cadena síncrona secuencial: A -> B -> C -> D
// ---------------------------------------------------------------------------
function secuencial(): Resultado {
  let exitos = 0;
  const latencias: number[] = [];
  for (let i = 0; i < N; i++) {
    let total = 0;
    let ok = true;
    for (const s of SERVICIOS) {
      const [r, lat] = llamar(s);
      total += lat;
      if (!r) { ok = false; break; }   // falla la orden entera
    }
    latencias.push(total);
    if (ok) exitos++;
  }
  return { exitos, latencias };
}

// ---------------------------------------------------------------------------
// DISEÑO 2 — Paralelo con timeout y degradación: los NO críticos no bloquean
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 300;

function paraleloDegradado(): Resultado {
  let exitos = 0;
  const latencias: number[] = [];
  for (let i = 0; i < N; i++) {
    let peorCritico = 0;
    let ok = true;
    for (const s of SERVICIOS) {
      const [r, lat] = llamar(s);
      const latEfectiva = Math.min(lat, TIMEOUT_MS);   // el timeout corta la cola
      if (s.critico) {
        peorCritico = Math.max(peorCritico, latEfectiva);
        // un crítico que falla O que se pasa del timeout tumba la orden
        if (!r || lat > TIMEOUT_MS) ok = false;
      }
      // los no críticos: si fallan o tardan, se degradan y no afectan nada
    }
    latencias.push(peorCritico);
    if (ok) exitos++;
  }
  return { exitos, latencias };
}

// ---------------------------------------------------------------------------
// DISEÑO 3 — Críticos sincrónicos, no críticos por cola (outbox + eventos)
// ---------------------------------------------------------------------------
function asincrono(): Resultado {
  let exitos = 0;
  const latencias: number[] = [];
  const criticos = SERVICIOS.filter((s) => s.critico);
  for (let i = 0; i < N; i++) {
    let peor = 0;
    let ok = true;
    for (const s of criticos) {
      const [r, lat] = llamar(s);
      const latEfectiva = Math.min(lat, TIMEOUT_MS);
      peor = Math.max(peor, latEfectiva);
      if (!r || lat > TIMEOUT_MS) ok = false;
    }
    // C y D: se publica un evento. Costo ~2 ms. Si están caídos, el mensaje
    // espera en la cola y se procesa después. NO afectan a esta request.
    latencias.push(peor + 2);
    if (ok) exitos++;
  }
  return { exitos, latencias };
}


// ---------------------------------------------------------------------------
// DISEÑO 4 — igual al 3, pero con UN reintento en los críticos
// (sólo es válido si la operación es idempotente: módulo 06)
// ---------------------------------------------------------------------------
function asincronoConReintento(): Resultado {
  let exitos = 0;
  const latencias: number[] = [];
  const criticos = SERVICIOS.filter((s) => s.critico);
  for (let i = 0; i < N; i++) {
    let acumulada = 0;
    let ok = true;
    for (const s of criticos) {
      let intentoOk = false;
      let latServicio = 0;
      for (let intento = 0; intento < 2; intento++) {
        const [r, lat] = llamar(s);
        latServicio += Math.min(lat, TIMEOUT_MS);
        if (r && lat <= TIMEOUT_MS) { intentoOk = true; break; }
      }
      acumulada = Math.max(acumulada, latServicio);
      if (!intentoOk) ok = false;
    }
    latencias.push(acumulada + 2);
    if (ok) exitos++;
  }
  return { exitos, latencias };
}

console.log('='.repeat(72));
console.log('  POST /orders — mismo negocio, tres arquitecturas, ' + N.toLocaleString('es-AR') + ' órdenes');
console.log('='.repeat(72));
console.log('  4 servicios, 99,9% de disponibilidad cada uno.');
console.log('  A (stock) y B (cobro) son críticos. C (envío) y D (mail) no lo son.');

reportar(
  'DISEÑO 1 — cadena síncrona: A -> B -> C -> D, todos obligatorios',
  secuencial(),
  'Techo teórico: 0,999^4 = 99,60%. Cada dependencia agregada te cuesta\n' +
  '  disponibilidad Y latencia. D es un MAIL y puede tumbar una venta.',
);

reportar(
  'DISEÑO 2 — paralelo + timeout de ' + TIMEOUT_MS + ' ms + degradación de no críticos',
  paraleloDegradado(),
  'Sólo A y B pueden tumbar la orden -> techo 0,999^2 = 99,80%.\n' +
  '  El p99 mejora muchísimo: el timeout corta la cola en seco.\n' +
  '  PERO el timeout también rechaza órdenes que iban a salir bien\n' +
  '  (mirá cómo la disponibilidad queda por DEBAJO de 99,80%: ese es el\n' +
  '  costo real de un timeout agresivo, y por eso el timeout se elige\n' +
  '  mirando el p99 de la dependencia, no "un número redondo").',
);

reportar(
  'DISEÑO 3 — A y B sincrónicos, C y D por evento (outbox + cola)',
  asincrono(),
  'C y D salieron del camino crítico. Si el servicio de envíos está\n' +
  '  caído 3 horas, NO se pierde ninguna orden: los eventos esperan.\n' +
  '  A cambio pagás: consistencia eventual (el envío se reserva "en un\n' +
  '  rato"), posibles duplicados (módulo 06: idempotencia), y outbox\n' +
  '  para no perder el evento si el proceso muere (módulo 09).',
);

reportar(
  'DISEÑO 4 — igual al 3 + UN reintento en los críticos (requiere idempotencia)',
  asincronoConReintento(),
  'Acá aparece la respuesta completa. El timeout del diseño 2/3 convertía\n' +
  '  la cola en errores; el reintento la recupera, porque la mayoría de esos\n' +
  '  fallos eran TRANSITORIOS (un pico, un GC, un pod reciclándose).\n' +
  '  Disponibilidad por servicio: 1 - 0,011^2 = 99,99%.\n' +
  '  PERO OJO, y esto es lo que separa una respuesta buena de una peligrosa:\n' +
  '  reintentar un COBRO sin idempotencia cobra dos veces. El reintento sólo\n' +
  '  es legítimo con Idempotency-Key end-to-end (módulos 06 y 13), y con\n' +
  '  backoff + jitter para no amplificar una caída (módulo 08).',
);

console.log(`
${'='.repeat(72)}
  LO QUE HAY QUE LLEVARSE
${'='.repeat(72)}

  1. Sacar una dependencia del camino crítico te devuelve su factor
     ENTERO de disponibilidad. Es la palanca más barata que existe:
     no requiere que nadie mejore su servicio.

  2. Un timeout es un intercambio explícito: cambiás latencia de cola
     por tasa de error. Elegilo mirando el p99 real de la dependencia
     (si su p99 es 250 ms, un timeout de 300 ms es razonable; uno de
     100 ms convierte el 5% de tu tráfico normal en errores).

  3. Lo asíncrono NO es "mejor". Es un intercambio: comprás
     disponibilidad y absorción de picos, y pagás con consistencia
     eventual, duplicados, orden y dificultad de debugging.
     Si no podés nombrar ese precio, no entendiste la decisión.

  4. Timeout SIN reintento es media solución: te arregla el p99 y te
     empeora la tasa de error. Timeout + reintento con backoff arregla
     las dos... y sólo es seguro si la operación es idempotente.
     Comparar el diseño 3 con el 4 es toda la fase 2 de este path en
     una tabla.

  5. La pregunta que ordena todo: "¿qué pasa si esto tarda 5 minutos
     en ocurrir?". Si la respuesta es "nada grave", va por cola.
`);

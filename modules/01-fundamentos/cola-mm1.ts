/**
 * Módulo 01 — Por qué un sistema explota antes de llegar al 100% de uso.
 *
 *   node modules/01-fundamentos/cola-mm1.ts
 *
 * Simulación de eventos discretos de una cola M/M/1: un solo worker,
 * llegadas aleatorias (Poisson), tiempo de servicio aleatorio (exponencial).
 * Es el modelo de un pod de NestJS, un consumer de Kafka o un pool de
 * conexiones: hay una cola, hay un servidor, y la carga no llega prolija.
 *
 * Lo que se ve: la latencia NO crece linealmente con la carga. Entre 70% y
 * 95% de utilización la latencia se multiplica por 6, con el mismo hardware
 * y el mismo código.
 */

const TIEMPO_SERVICIO_MS = 20;  // cuánto tarda el worker en atender una request
const REQUESTS_POR_CORRIDA = 300_000;

/** Variable aleatoria exponencial de media `media`. */
function exponencial(media: number): number {
  return -Math.log(1 - Math.random()) * media;
}

function percentil(ordenadas: number[], p: number): number {
  const idx = Math.min(ordenadas.length - 1, Math.ceil((p / 100) * ordenadas.length) - 1);
  return ordenadas[idx];
}

/**
 * Simula la cola a una utilización dada.
 * Devuelve las latencias observadas (espera en cola + servicio), en ms.
 */
function simular(utilizacion: number): number[] {
  const intervaloLlegadas = TIEMPO_SERVICIO_MS / utilizacion;

  let reloj = 0;              // momento de la última llegada
  let libreEn = 0;            // momento en que el worker queda libre
  const latencias: number[] = [];

  for (let i = 0; i < REQUESTS_POR_CORRIDA; i++) {
    reloj += exponencial(intervaloLlegadas);
    const empiezaAtenderse = Math.max(reloj, libreEn);
    const espera = empiezaAtenderse - reloj;         // <-- tiempo en cola
    const servicio = exponencial(TIEMPO_SERVICIO_MS);
    libreEn = empiezaAtenderse + servicio;
    latencias.push(espera + servicio);
  }

  return latencias.sort((a, b) => a - b);
}

console.log('='.repeat(74));
console.log('LATENCIA vs UTILIZACIÓN — un worker, tiempo de servicio de ' + TIEMPO_SERVICIO_MS + ' ms');
console.log('='.repeat(74));
console.log('  Mismo hardware. Mismo código. Sólo cambia cuánta carga le mandás.\n');
console.log('   uso    req/s     p50        p95        p99        vs. ideal   teoría M/M/1');
console.log('  ' + '-'.repeat(72));

for (const uso of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]) {
  const lat = simular(uso);
  const p50 = percentil(lat, 50);
  const p95 = percentil(lat, 95);
  const p99 = percentil(lat, 99);
  const promedio = lat.reduce((a, b) => a + b, 0) / lat.length;
  const teorico = TIEMPO_SERVICIO_MS / (1 - uso); // W = S / (1 - ρ)
  const qps = (1000 / TIEMPO_SERVICIO_MS) * uso;

  const alarma = uso >= 0.9 ? '  <-- acá vive el incidente' : '';
  console.log(
    `  ${(uso * 100).toFixed(0).padStart(3)}%  ${qps.toFixed(0).padStart(6)}  ` +
      `${p50.toFixed(0).padStart(6)} ms  ${p95.toFixed(0).padStart(6)} ms  ${p99.toFixed(0).padStart(6)} ms  ` +
      `${(promedio / TIEMPO_SERVICIO_MS).toFixed(1).padStart(8)}x  ${teorico.toFixed(0).padStart(8)} ms${alarma}`,
  );
}

console.log(`
  LEER ASÍ:
   - Pasar de 70% a 90% de utilización te da 28% más de throughput...
     y multiplica la latencia por ~3. Es un pésimo negocio.
   - El p99 a 95% de uso es de otro orden de magnitud que el p99 a 60%.
     Nada cambió en el código: cambió la cola.
   - Por eso la regla operativa es apuntar a 60-70% de utilización
     sostenida. Ese 30% "ocioso" no se desperdicia: se paga con él el
     pico de tráfico, el deploy, y la instancia que se cae.

  ESTO ES LA RESPUESTA A: "la CPU estaba en 85%, ¿por qué se cayó todo?".

  Y OJO CON LA TRAMPA: si la utilización llega a 1.0 (llegan más requests
  de las que podés atender), la cola no se estabiliza en un valor alto —
  crece PARA SIEMPRE. Los timeouts empiezan a disparar, los clientes
  reintentan, la carga sube todavía más y entra en colapso metaestable.
  De eso se defiende el módulo 08 (backpressure, load shedding, circuit
  breakers): en sobrecarga, RECHAZAR rápido es más sano que encolar.
`);

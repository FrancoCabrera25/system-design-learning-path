/**
 * Módulo 01 — El ritual de los primeros 5 minutos de una entrevista.
 *
 *   node modules/01-fundamentos/back-of-the-envelope.ts
 *
 * Caso: plataforma de agentes de IA. Los usuarios mandan mensajes, un
 * servicio NestJS los recibe, publica un evento en Kafka, un worker llama
 * a un LLM (que a su vez puede llamar herramientas) y persiste todo en
 * Postgres. Es, básicamente, tu stack.
 *
 * CAMBIÁ LOS INPUTS DE ABAJO y mirá qué decisión de arquitectura se cae.
 * Ese es todo el ejercicio: los números eligen la arquitectura, no al revés.
 */

// ---------------------------------------------------------------------------
// INPUTS — lo único que se toca
// ---------------------------------------------------------------------------
const DAU = 200_000;                    // usuarios activos por día
const CONVERSACIONES_POR_USUARIO = 3;   // por día
const MENSAJES_POR_CONVERSACION = 8;    // ida y vuelta con el agente
const FACTOR_PICO = 5;                  // tráfico humano regional: 3x a 10x
const BYTES_POR_MENSAJE = 1_200;        // texto + metadata
const BYTES_POR_TRAZA_AGENTE = 25_000;  // prompt, tool calls, respuesta: se guarda todo
const RETENCION_DIAS = 365;
const LECTURAS_POR_ESCRITURA = 12;      // abrir el historial, reintentos de UI, etc.
const REPLICACION = 3;                  // copias de los datos
const LATENCIA_LLM_S = 6;               // segundos por llamada al modelo
const COSTO_POR_1K_TOKENS_USD = 0.005;
const TOKENS_POR_MENSAJE = 2_500;       // prompt + contexto + respuesta

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SEG_POR_DIA = 86_400;
const fmt = (n: number, dec = 1) =>
  n.toLocaleString('es-AR', { maximumFractionDigits: dec });
const bytes = (n: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
};
const titulo = (t: string) => console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);

// ---------------------------------------------------------------------------
// 1. Tráfico
// ---------------------------------------------------------------------------
const mensajesPorDia = DAU * CONVERSACIONES_POR_USUARIO * MENSAJES_POR_CONVERSACION;
const escrituraQPS = mensajesPorDia / SEG_POR_DIA;
const escrituraPico = escrituraQPS * FACTOR_PICO;
const lecturaQPS = escrituraQPS * LECTURAS_POR_ESCRITURA;
const lecturaPico = lecturaQPS * FACTOR_PICO;

titulo('1. TRÁFICO');
console.log(`  mensajes/día            ${fmt(mensajesPorDia, 0)}`);
console.log(`  escrituras promedio     ${fmt(escrituraQPS)} req/s`);
console.log(`  escrituras PICO (x${FACTOR_PICO})    ${fmt(escrituraPico)} req/s   <-- dimensionás por esto`);
console.log(`  lecturas promedio       ${fmt(lecturaQPS)} req/s`);
console.log(`  lecturas PICO           ${fmt(lecturaPico)} req/s`);
console.log(`  ratio lectura:escritura ${LECTURAS_POR_ESCRITURA}:1  -> read-heavy: réplicas de lectura + caché ganan mucho`);

// ---------------------------------------------------------------------------
// 2. Storage
// ---------------------------------------------------------------------------
const bytesPorDia = mensajesPorDia * (BYTES_POR_MENSAJE + BYTES_POR_TRAZA_AGENTE);
const bytesRetenidos = bytesPorDia * RETENCION_DIAS;

titulo('2. STORAGE');
console.log(`  por día (crudo)         ${bytes(bytesPorDia)}`);
console.log(`  a ${RETENCION_DIAS} días              ${bytes(bytesRetenidos)}`);
console.log(`  con replicación x${REPLICACION}      ${bytes(bytesRetenidos * REPLICACION)}`);
console.log(`  sólo mensajes (sin traza) ${bytes(mensajesPorDia * BYTES_POR_MENSAJE * RETENCION_DIAS)}`);
console.log(`
  DECISIÓN: la traza del agente es ${(BYTES_POR_TRAZA_AGENTE / BYTES_POR_MENSAJE).toFixed(0)}x más grande que el mensaje.
  Meterla en la misma tabla de Postgres que los mensajes hace que cada
  query de historial arrastre datos que nadie lee. Separar: mensajes en
  Postgres (chico, transaccional, consultado), trazas en S3 con puntero
  en la fila (barato, append-only, se lee en debugging).`);

// ---------------------------------------------------------------------------
// 3. Ancho de banda
// ---------------------------------------------------------------------------
titulo('3. ANCHO DE BANDA');
console.log(`  ingest promedio         ${bytes(escrituraQPS * BYTES_POR_MENSAJE)}/s`);
console.log(`  ingest pico             ${bytes(escrituraPico * BYTES_POR_MENSAJE)}/s`);
console.log(`  egress lecturas pico    ${bytes(lecturaPico * BYTES_POR_MENSAJE)}/s`);
console.log(`  hacia Kafka (con traza) ${bytes(escrituraPico * (BYTES_POR_MENSAJE + BYTES_POR_TRAZA_AGENTE))}/s`);

// ---------------------------------------------------------------------------
// 4. Concurrencia — Ley de Little aplicada al LLM
// ---------------------------------------------------------------------------
const concurrenciaLLM = escrituraPico * LATENCIA_LLM_S;   // L = λ × W

titulo('4. CONCURRENCIA (Ley de Little: L = λ × W)');
console.log(`  λ (pico)                ${fmt(escrituraPico)} llamadas/s`);
console.log(`  W (latencia LLM)        ${LATENCIA_LLM_S} s`);
console.log(`  L = llamadas al LLM en vuelo al mismo tiempo: ${fmt(concurrenciaLLM, 0)}`);
console.log(`
  ESTE ES EL NÚMERO QUE MANDA. ${fmt(concurrenciaLLM, 0)} llamadas concurrentes:
   - ¿Tu proveedor de LLM te da ese rate limit? Si no, la cola crece y
     el diseño es inválido. Hay que negociar cuota o encolar con backpressure.
   - Si un pod de NestJS sostiene 200 llamadas en vuelo (son I/O, no CPU),
     necesitás ~${Math.ceil(concurrenciaLLM / 200)} pods sólo para no acumular cola.
   - Con 6 segundos de latencia, la request HTTP síncrona NO es opción:
     va por Kafka/SQS + streaming (SSE/WebSocket) hacia el cliente.`);

const conexionesDB = escrituraPico * 0.005 + lecturaPico * 0.002; // 5ms write, 2ms read
console.log(`\n  Pool de Postgres necesario (Little, otra vez): ~${Math.ceil(conexionesDB)} conexiones activas.`);
console.log(`  Si tenés 20 pods x pool de 50 = 1000 conexiones abiertas contra una`);
console.log(`  base que soporta ~500: el problema no se arregla con más pods, se`);
console.log(`  arregla con PgBouncer. (Módulo 05.)`);

// ---------------------------------------------------------------------------
// 5. Costo — en sistemas de IA el costo ES un requisito de diseño
// ---------------------------------------------------------------------------
const tokensPorDia = mensajesPorDia * TOKENS_POR_MENSAJE;
const costoDia = (tokensPorDia / 1000) * COSTO_POR_1K_TOKENS_USD;

titulo('5. COSTO DE INFERENCIA');
console.log(`  tokens/día              ${fmt(tokensPorDia, 0)}`);
console.log(`  USD/día                 $${fmt(costoDia, 0)}`);
console.log(`  USD/mes                 $${fmt(costoDia * 30, 0)}`);
console.log(`  USD/año                 $${fmt(costoDia * 365, 0)}`);
console.log(`  costo por usuario/mes   $${fmt((costoDia * 30) / DAU, 3)}`);
console.log(`
  Comparalo con lo que cobrás por usuario. En un sistema de IA el modelo
  suele costar más que TODA la infraestructura junta, y por eso aparecen
  como decisiones de arquitectura de primer orden:
    - caché semántico de respuestas    (¿cuántas preguntas se repiten?)
    - routing por modelo               (barato por defecto, caro si hace falta)
    - recorte/compresión de contexto   (el prompt es la mayor parte del costo)
    - caché de prompt del proveedor    (descuento fuerte en el prefijo repetido)`);

titulo('RESUMEN: qué eligieron los números');
console.log(`
  ${fmt(escrituraPico, 0)} escrituras/s pico   -> una sola instancia de Postgres aguanta;
                            NO hace falta sharding todavía (módulo 05).
  ${LECTURAS_POR_ESCRITURA}:1 lectura/escritura  -> réplica de lectura + caché en Redis (módulo 04).
  ${LATENCIA_LLM_S}s de latencia del LLM  -> procesamiento asíncrono obligatorio (módulos 02 y 07).
  ${fmt(concurrenciaLLM, 0)} llamadas en vuelo    -> el rate limit del proveedor es el cuello
                            de botella real; hace falta cola con backpressure.
  ${bytes(bytesRetenidos)} de trazas          -> S3 + puntero, no Postgres.
  $${fmt(costoDia * 30, 0)}/mes de inferencia -> el costo es un requisito, no una consecuencia.

  Ninguna de estas cinco decisiones salió de una preferencia técnica.
  Todas salieron de un número. Ese es el punto del módulo.`);

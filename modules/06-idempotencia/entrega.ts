/**
 * Módulo 06 — At-most-once, at-least-once y por qué "exactly-once" es mentira.
 *
 *   node modules/06-idempotencia/entrega.ts
 *
 * Un consumer de Kafka procesa mensajes y, por cada uno, llama a un LLM que
 * cuesta dinero. Los rebalances y los deploys hacen que se reprocese lo que
 * no llegó a commitear el offset.
 *
 * La pregunta no es "¿puede pasar?" sino "¿cuánto cuesta por año?".
 */

const MSG_POR_SEG = 500;
const INTERVALO_COMMIT_S = 5;      // auto.commit.interval.ms = 5000
const EVENTOS_POR_DIA = 12;        // deploys, autoscaling, pods reciclados,
                                   // rebalances por red, OOM kills
const COSTO_LLM_USD = 0.02;        // por llamada
const COSTO_DEDUP_USD = 0.0000002; // un SETNX en Redis / un INSERT ON CONFLICT

const MSG_POR_DIA = MSG_POR_SEG * 86_400;
/** Lo que se reprocesa (o se pierde) en cada evento: lo no commiteado. */
const VENTANA = MSG_POR_SEG * INTERVALO_COMMIT_S;
const AFECTADOS_POR_DIA = VENTANA * EVENTOS_POR_DIA;

const fmt = (n: number, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d });

console.log('='.repeat(82));
console.log(`  ${fmt(MSG_POR_SEG)} msg/s · commit cada ${INTERVALO_COMMIT_S} s · ${EVENTOS_POR_DIA} rebalances o deploys por día`);
console.log('='.repeat(82));
console.log(`  ${fmt(MSG_POR_DIA)} mensajes/día. Cada uno llama a un LLM: USD ${COSTO_LLM_USD} por llamada.`);
console.log(`  En cada evento quedan ${fmt(VENTANA)} mensajes sin commitear (${INTERVALO_COMMIT_S} s × ${fmt(MSG_POR_SEG)} msg/s).\n`);

interface Semantica {
  nombre: string;
  perdidos: number;
  duplicados: number;
  efectosDuplicados: number;
  nota: string;
}

const SEMANTICAS: Semantica[] = [
  {
    nombre: 'at-most-once',
    perdidos: AFECTADOS_POR_DIA,
    duplicados: 0,
    efectosDuplicados: 0,
    nota: 'commitea el offset ANTES de procesar. Nunca duplica... y pierde.',
  },
  {
    nombre: 'at-least-once (sin dedup)',
    perdidos: 0,
    duplicados: AFECTADOS_POR_DIA,
    efectosDuplicados: AFECTADOS_POR_DIA,
    nota: 'commitea DESPUÉS. El default de todos los brokers. Duplica.',
  },
  {
    nombre: 'Kafka EOS (transacciones)',
    perdidos: 0,
    duplicados: 0,
    efectosDuplicados: AFECTADOS_POR_DIA,
    nota: 'atómico DENTRO de Kafka. La llamada al LLM está AFUERA.',
  },
  {
    nombre: '"effectively once"',
    perdidos: 0,
    duplicados: AFECTADOS_POR_DIA,
    efectosDuplicados: 0,
    nota: 'at-least-once + handler idempotente. Los duplicados llegan y no hacen nada.',
  },
];

console.log('  semántica                   perdidos/día   duplicados/día   LLAMADAS AL LLM DE MÁS   USD/año');
console.log('  ' + '-'.repeat(80));

for (const s of SEMANTICAS) {
  const usdAnio = s.efectosDuplicados * COSTO_LLM_USD * 365;
  const icono = s.perdidos > 0 ? '💀' : s.efectosDuplicados > 0 ? '💀' : '✅';
  console.log(
    `  ${s.nombre.padEnd(27)} ${fmt(s.perdidos).padStart(12)}   ${fmt(s.duplicados).padStart(14)}   ` +
      `${fmt(s.efectosDuplicados).padStart(22)}   $${fmt(usdAnio).padStart(9)}  ${icono}`,
  );
}

const costoDedup = MSG_POR_DIA * COSTO_DEDUP_USD * 365;
const ahorro = AFECTADOS_POR_DIA * COSTO_LLM_USD * 365;

console.log(`\n  ${'-'.repeat(80)}`);
for (const s of SEMANTICAS) console.log(`  ${s.nombre.padEnd(27)} ${s.nota}`);

console.log(`
  LO QUE HAY QUE VER

  AT-MOST-ONCE no es "la opción segura": es la opción que PIERDE. ${fmt(AFECTADOS_POR_DIA)}
  mensajes por día que nadie procesó y de los que no queda registro. Sirve
  para telemetría y métricas, donde perder una muestra no cambia nada. Para
  un pago, para un pedido o para una acción de un agente, no.

  AT-LEAST-ONCE es el default de Kafka, SQS, RabbitMQ y Redis Streams — y
  también el del outbox del módulo 02, que republica si muere entre publicar
  y marcar. No es una elección: es la realidad con la que trabajás.

  KAFKA EOS ES LA FILA MÁS IMPORTANTE DE LA TABLA.
  Las transacciones de Kafka son reales y funcionan: hacen atómico el ciclo
  consumir → transformar → producir, con el offset y los mensajes de salida
  commiteados juntos. Cero duplicados DENTRO de Kafka.

  Y mirá la columna de llamadas al LLM: sigue igual de mal. Porque la llamada
  al LLM —como tu INSERT en Postgres, como tu POST a Stripe— OCURRE FUERA DE
  KAFKA, y ninguna transacción de Kafka la puede deshacer. Ya pagaste los
  tokens.

     "Activamos exactly-once" NO significa que tus efectos ocurran una vez.
     Significa que el mensaje no se duplica entre topics de Kafka.

  Confundir esas dos cosas es el error clásico del tema, y es caro:
  $${fmt(ahorro)} por año en este ejemplo.

  "EFFECTIVELY ONCE" ES LO QUE SÍ SE CONSTRUYE

     at-least-once  +  handler idempotente  =  effectively once

  Los duplicados SIGUEN LLEGANDO (mirá la columna: ${fmt(AFECTADOS_POR_DIA)} por día), y no
  producen ningún efecto. La garantía no vive en el broker: vive en el efecto.

  Y es baratísimo. Deduplicar cuesta un SETNX o un INSERT ... ON CONFLICT
  por mensaje:

     costo de deduplicar TODO      $${fmt(costoDedup)} / año
     costo de NO deduplicar        $${fmt(ahorro)} / año
     relación                      ${fmt(ahorro / costoDedup)}x

  DÓNDE PONER LA MARCA, que es lo único delicado:

     ✅ En la MISMA transacción que el efecto, cuando el efecto es tuyo
        (INSERT ... ON CONFLICT DO NOTHING sobre el eventId + el UPDATE,
         los dos en el mismo BEGIN/COMMIT).
     ⚠️  Antes del efecto, si el efecto es externo: registrás la intención,
        ejecutás, y consultás al proveedor antes de reintentar a ciegas.
     ❌ Después del efecto, sin transacción: si el proceso muere en el
        medio, duplicás igual. Es la fila 4 de idempotencia.ts.

  LA FRASE PARA UNA ENTREVISTA

     "Exactly-once de punta a punta no existe: el emisor nunca puede saber
      si el receptor procesó el mensaje, y el ack también se puede perder.
      Lo que se construye es at-least-once con consumidores idempotentes.
      El exactly-once de Kafka es real pero sólo cubre Kafka-a-Kafka; en
      cuanto el efecto sale del broker, la garantía se termina."
`);

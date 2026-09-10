/**
 * Módulo 02 — Por qué protobuf es chico: escribiendo el encoder a mano.
 *
 *   node modules/02-comunicacion-servicios/proto-vs-json.ts
 *
 * No usamos ninguna librería. Implementamos el wire format de Protobuf en
 * ~50 líneas, porque escribir un varint a mano explica en 5 minutos lo que
 * un blog no explica en 20: el mensaje NO lleva los nombres de los campos,
 * lleva NÚMEROS. De ahí sale todo: el tamaño, la velocidad, y las reglas de
 * evolución del schema (por qué renombrar es gratis y renumerar es fatal).
 *
 * El .proto equivalente sería:
 *
 *   message Item  { int64 sku = 1; int32 qty = 2; int32 price_cents = 3; }
 *   message Order {
 *     string id           = 1;
 *     int64  user_id      = 2;
 *     int32  amount_cents = 3;
 *     string currency     = 4;
 *     bool   paid         = 5;
 *     repeated Item items = 6;
 *   }
 */

// ---------------------------------------------------------------------------
// El wire format, completo, en 40 líneas
// ---------------------------------------------------------------------------

/**
 * Varint: enteros de longitud variable. Se guardan de a 7 bits por byte;
 * el bit más alto (0x80) dice "sigue otro byte". Números chicos ocupan 1
 * byte. Por eso conviene que los campos más usados tengan números del 1 al
 * 15: su TAG entra en un solo byte.
 */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Cada campo va precedido por un tag = (número_de_campo << 3) | wire_type */
const WIRE_VARINT = 0;   // int32, int64, bool, enum
const WIRE_LEN = 2;      // string, bytes, mensajes anidados, repeated empaquetado

function tag(campo: number, tipo: number): number[] {
  return varint((campo << 3) | tipo);
}

function campoVarint(campo: number, valor: number): number[] {
  return [...tag(campo, WIRE_VARINT), ...varint(valor)];
}

function campoString(campo: number, valor: string): number[] {
  const bytes = [...Buffer.from(valor, 'utf8')];
  return [...tag(campo, WIRE_LEN), ...varint(bytes.length), ...bytes];
}

function campoMensaje(campo: number, cuerpo: number[]): number[] {
  return [...tag(campo, WIRE_LEN), ...varint(cuerpo.length), ...cuerpo];
}

function campoBool(campo: number, valor: boolean): number[] {
  // proto3 NO serializa valores por defecto: false, 0 y "" simplemente no
  // se mandan. Ése es otro motivo por el que los mensajes salen chicos.
  return valor ? campoVarint(campo, 1) : [];
}

// ---------------------------------------------------------------------------
// El mensaje de ejemplo
// ---------------------------------------------------------------------------

interface Item { sku: number; qty: number; priceCents: number; }
interface Order {
  id: string;
  userId: number;
  amountCents: number;
  currency: string;
  paid: boolean;
  items: Item[];
}

function nuevaOrden(nItems: number): Order {
  return {
    id: 'ord_7f3a9c1e-4b22-4a1d-9f80-2c5e6d7a8b90',
    userId: 8_412_337,
    amountCents: 149_900,
    currency: 'ARS',
    paid: true,
    items: Array.from({ length: nItems }, (_, i) => ({
      sku: 900_000_000 + i,
      qty: 1 + (i % 3),
      priceCents: 1_990 + i * 37,
    })),
  };
}

function encodeItem(it: Item): number[] {
  return [
    ...campoVarint(1, it.sku),
    ...campoVarint(2, it.qty),
    ...campoVarint(3, it.priceCents),
  ];
}

function encodeOrder(o: Order): Buffer {
  const out: number[] = [
    ...campoString(1, o.id),
    ...campoVarint(2, o.userId),
    ...campoVarint(3, o.amountCents),
    ...campoString(4, o.currency),
    ...campoBool(5, o.paid),
  ];
  for (const it of o.items) out.push(...campoMensaje(6, encodeItem(it)));
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// 1. Anatomía: qué viaja realmente por el cable
// ---------------------------------------------------------------------------

const chica = nuevaOrden(2);
const bufChica = encodeOrder(chica);
const jsonChica = Buffer.from(JSON.stringify(chica), 'utf8');

console.log('='.repeat(72));
console.log('1. QUÉ VIAJA POR EL CABLE');
console.log('='.repeat(72));
console.log('\nJSON (' + jsonChica.length + ' bytes) — legible, y por eso caro:\n');
console.log('  ' + JSON.stringify(chica).slice(0, 150) + '...');
console.log('\nProtobuf (' + bufChica.length + ' bytes) — los primeros 48 bytes en hex:\n');
console.log('  ' + bufChica.subarray(0, 48).toString('hex').match(/.{1,2}/g)!.join(' '));

console.log(`
  Mirá el primer byte: 0x0a = 00001010.
    >> 3          = 1     -> es el CAMPO 1 (id)
    & 0b111       = 2     -> wire type 2 (longitud + bytes)
  El siguiente byte (0x${bufChica[1].toString(16)}) es el largo del string. Después, el string.

  Buscá la palabra "userId" en el hex. NO ESTÁ. Ni "amountCents", ni
  "currency". Los nombres de los campos NO VIAJAN: los dos lados ya los
  conocen porque compilaron el mismo .proto.

  Ésa es la razón técnica exacta de las reglas de evolución del schema:
    - Renombrar un campo es GRATIS       (el nombre no viaja)
    - Cambiar su NÚMERO rompe todo       (el número ES la identidad)
    - Reutilizar un número borrado es lo PEOR que podés hacer: el
      consumidor viejo lee los bytes nuevos con el significado viejo,
      sin ningún error. Corrupción silenciosa. Por eso existe 'reserved'.`);

// ---------------------------------------------------------------------------
// 2. Tamaño según cantidad de items
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(72)}`);
console.log('2. TAMAÑO — protobuf vs JSON');
console.log('='.repeat(72));
console.log('\n  items      JSON      protobuf    reducción');
console.log('  ' + '-'.repeat(46));

for (const n of [1, 5, 20, 100, 500]) {
  const o = nuevaOrden(n);
  const j = Buffer.byteLength(JSON.stringify(o), 'utf8');
  const p = encodeOrder(o).length;
  console.log(
    `  ${String(n).padStart(5)}  ${String(j).padStart(8)} B  ${String(p).padStart(8)} B` +
      `    ${(((j - p) / j) * 100).toFixed(1).padStart(6)} %`,
  );
}

console.log(`
  La reducción crece con la cantidad de elementos repetidos, porque en
  JSON cada item repite "sku", "qty" y "priceCents" como TEXTO. En
  protobuf cada uno de esos campos es 1 byte de tag.`);

// ---------------------------------------------------------------------------
// 3. Velocidad de serialización
// ---------------------------------------------------------------------------

const ITERACIONES = 20_000;
const grande = nuevaOrden(50);

function medir(fn: () => void): number {
  fn(); // calentar el JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERACIONES; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const tJson = medir(() => { JSON.stringify(grande); });
const tProto = medir(() => { encodeOrder(grande); });
const payloadJson = JSON.stringify(grande);
const payloadProto = encodeOrder(grande);
const tJsonParse = medir(() => { JSON.parse(payloadJson); });

console.log(`${'='.repeat(72)}`);
console.log('3. VELOCIDAD (orden con 50 items, ' + ITERACIONES.toLocaleString('es-AR') + ' iteraciones)');
console.log('='.repeat(72));
console.log(`\n  JSON.stringify           ${tJson.toFixed(0).padStart(6)} ms   (${((tJson / ITERACIONES) * 1000).toFixed(1)} µs por mensaje)`);
console.log(`  encoder protobuf casero  ${tProto.toFixed(0).padStart(6)} ms   (${((tProto / ITERACIONES) * 1000).toFixed(1)} µs por mensaje)`);
console.log(`  JSON.parse               ${tJsonParse.toFixed(0).padStart(6)} ms`);
console.log(`
  HONESTIDAD INTELECTUAL: nuestro encoder casero usa arrays de JS y es
  ineficiente a propósito (es didáctico). JSON.stringify está escrito en
  C++ dentro de V8 y es de las funciones más optimizadas del runtime, así
  que puede ganarle a esta implementación. Con protobufjs o @grpc/grpc-js
  la comparación se da vuelta.

  Pero el punto NO es el microbenchmark de CPU. Es esto:

    payload JSON     ${payloadJson.length.toLocaleString('es-AR').padStart(8)} bytes
    payload protobuf ${payloadProto.length.toLocaleString('es-AR').padStart(8)} bytes   (${(100 - (payloadProto.length / payloadJson.length) * 100).toFixed(0)}% menos)

  A 5.000 req/s eso son ${(((payloadJson.length - payloadProto.length) * 5000) / 1024 / 1024).toFixed(1)} MB/s menos de red, todo el día. Y en
  una arquitectura de microservicios la red es el recurso escaso, no la
  CPU (módulo 01: el round-trip domina la latencia).

  Y el beneficio más grande de todos ni siquiera se mide acá: el .proto
  es un CONTRATO COMPILADO. Si un equipo cambia un tipo, te enterás en el
  build, no a las 3 de la mañana con un 500 en producción.`);

console.log(`
${'='.repeat(72)}
  CUÁNDO NO USAR gRPC/PROTOBUF
${'='.repeat(72)}

  - API pública: tus consumidores quieren curl, Postman y OpenAPI.
  - Desde el navegador: necesitás gRPC-Web y un proxy (Envoy) en el medio.
  - Payloads chicos y poco tráfico: la ganancia es irrelevante y perdés
    debuggeabilidad. 40 req/s de JSON no son un problema de nadie.
  - Cuando el equipo no tiene pipeline de generación de código: un .proto
    sin CI que compile y publique los stubs es peor que un JSON honesto.

  Regla práctica: gRPC hacia adentro, REST hacia afuera, eventos para lo
  que no bloquea.
`);

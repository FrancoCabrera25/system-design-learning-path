/**
 * Módulo 02 — Qué pasa REALMENTE cuando cambiás un .proto.
 *
 *   node modules/02-comunicacion-servicios/evolucion-contrato.ts
 *
 * Serializamos un mensaje con el schema del PRODUCTOR VIEJO y lo decodificamos
 * con cinco schemas de CONSUMIDOR distintos — que es exactamente lo que pasa
 * durante un rolling update, cuando conviven las dos versiones.
 *
 * El resultado importante no es cuál falla. Es cuál NO falla y aun así te
 * corrompe los datos.
 */

// ---------------------------------------------------------------------------
// Encoder y decoder mínimos del wire format (ver proto-vs-json.ts)
// ---------------------------------------------------------------------------

const VARINT = 0;
const LEN = 2;

function encVarint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const encTag = (campo: number, tipo: number) => encVarint((campo << 3) | tipo);
const encInt = (campo: number, v: number) => [...encTag(campo, VARINT), ...encVarint(v)];
const encStr = (campo: number, v: string) => {
  const b = [...Buffer.from(v, 'utf8')];
  return [...encTag(campo, LEN), ...encVarint(b.length), ...b];
};

interface CampoCrudo { wireType: number; varint?: number; bytes?: Buffer; }

/**
 * Decodifica SIN conocer el schema: sólo sabe leer tags y valores.
 * Esto es literalmente lo que hace el runtime de protobuf antes de mapear
 * los números de campo a las propiedades de tu clase generada.
 */
function decodificar(buf: Buffer): Map<number, CampoCrudo> {
  const campos = new Map<number, CampoCrudo>();
  let i = 0;
  while (i < buf.length) {
    let tag = 0, shift = 0;
    while (true) { const b = buf[i++]; tag |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
    const numero = tag >>> 3;
    const wireType = tag & 0b111;

    if (wireType === VARINT) {
      let v = 0; shift = 0;
      while (true) { const b = buf[i++]; v |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      campos.set(numero, { wireType, varint: v });
    } else if (wireType === LEN) {
      let len = 0; shift = 0;
      while (true) { const b = buf[i++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      campos.set(numero, { wireType, bytes: buf.subarray(i, i + len) });
      i += len;
    } else {
      throw new Error(`wire type ${wireType} no soportado en este demo`);
    }
  }
  return campos;
}

// ---------------------------------------------------------------------------
// EL PRODUCTOR VIEJO (v1) — está en producción hace un año
// ---------------------------------------------------------------------------
//
//   message OrderCreated {
//     string id       = 1;
//     int32  amount   = 2;   // centavos
//     string currency = 3;
//   }

const ORIGINAL = { id: 'ord_9f21', amount: 149_900, currency: 'ARS' };

const bytes = Buffer.from([
  ...encStr(1, ORIGINAL.id),
  ...encInt(2, ORIGINAL.amount),
  ...encStr(3, ORIGINAL.currency),
]);

console.log('='.repeat(72));
console.log('  EL PRODUCTOR VIEJO manda esto');
console.log('='.repeat(72));
console.log(`  objeto  ${JSON.stringify(ORIGINAL)}`);
console.log(`  bytes   ${bytes.toString('hex').match(/.{1,2}/g)!.join(' ')}`);
console.log(`  tamaño  ${bytes.length} bytes`);
console.log(`
  Buscá "amount" o "currency" en ese hex: no están. Viajan los NÚMEROS
  de campo (1, 2, 3), no los nombres. Todo lo que sigue se deduce de eso.`);

// ---------------------------------------------------------------------------
// Los consumidores nuevos, cada uno con su cambio
// ---------------------------------------------------------------------------

type Schema = { campo: number; nombre: string; tipo: 'string' | 'int' }[];

function leerCon(schema: Schema, buf: Buffer): Record<string, unknown> {
  const crudo = decodificar(buf);
  const out: Record<string, unknown> = {};
  for (const { campo, nombre, tipo } of schema) {
    const c = crudo.get(campo);
    if (!c) { out[nombre] = tipo === 'int' ? 0 : ''; continue; }   // default proto3
    out[nombre] = tipo === 'int' ? (c.varint ?? 0) : (c.bytes?.toString('utf8') ?? '');
  }
  const desconocidos = [...crudo.keys()].filter((k) => !schema.some((s) => s.campo === k));
  if (desconocidos.length) out['<campos ignorados>'] = desconocidos;
  return out;
}

interface Caso {
  titulo: string;
  proto: string;
  schema: Schema;
  veredicto: (r: Record<string, unknown>) => string;
}

const CASOS: Caso[] = [
  {
    titulo: '(a) AGREGAR un campo nuevo con número nuevo',
    proto: 'string id=1; int32 amount=2; string currency=3; string coupon_code=4;',
    schema: [
      { campo: 1, nombre: 'id', tipo: 'string' },
      { campo: 2, nombre: 'amount', tipo: 'int' },
      { campo: 3, nombre: 'currency', tipo: 'string' },
      { campo: 4, nombre: 'couponCode', tipo: 'string' },
    ],
    veredicto: (r) =>
      r.amount === ORIGINAL.amount && r.currency === ORIGINAL.currency
        ? '✅ SEGURO — todo intacto; el campo nuevo queda en su valor por defecto ("")'
        : '❌ algo salió mal',
  },
  {
    titulo: '(b) RENOMBRAR amount -> amount_cents (mismo número)',
    proto: 'string id=1; int32 amount_cents=2; string currency=3;',
    schema: [
      { campo: 1, nombre: 'id', tipo: 'string' },
      { campo: 2, nombre: 'amountCents', tipo: 'int' },
      { campo: 3, nombre: 'currency', tipo: 'string' },
    ],
    veredicto: (r) =>
      r.amountCents === ORIGINAL.amount
        ? '✅ SEGURO en el cable — el nombre nunca viajó. ⚠️ Rompe la COMPILACIÓN\n            de quien regenere stubs (getAmount -> getAmountCents), y rompe de\n            verdad si en algún punto serializás a JSON.'
        : '❌ algo salió mal',
  },
  {
    titulo: '(c) CAMBIAR EL TIPO int32 -> int64 (mismo número)',
    proto: 'string id=1; int64 amount=2; string currency=3;',
    schema: [
      { campo: 1, nombre: 'id', tipo: 'string' },
      { campo: 2, nombre: 'amount', tipo: 'int' },
      { campo: 3, nombre: 'currency', tipo: 'string' },
    ],
    veredicto: (r) =>
      r.amount === ORIGINAL.amount
        ? '✅ SEGURO — int32/int64/uint32/uint64/bool/enum comparten wire type 0\n            (varint) y son intercambiables. NO vale para sint32 (zigzag) ni\n            fixed32 (wire type 5). Único riesgo: truncar valores > 2^31.'
        : '❌ algo salió mal',
  },
  {
    titulo: '(d) BORRAR currency y REUSAR el número 3 para country',
    proto: 'string id=1; int32 amount=2; string country=3;',
    schema: [
      { campo: 1, nombre: 'id', tipo: 'string' },
      { campo: 2, nombre: 'amount', tipo: 'int' },
      { campo: 3, nombre: 'country', tipo: 'string' },
    ],
    veredicto: (r) =>
      r.country === ORIGINAL.currency
        ? `💀 CATÁSTROFE SILENCIOSA — country = "${r.country}", que en realidad era\n            la MONEDA. Cero excepciones, cero warnings: los dos campos son\n            strings y el wire type coincide. El bug aparece semanas después,\n            en un reporte que no cierra. Esto es lo que previene 'reserved'.`
        : '❌ algo salió mal',
  },
  {
    titulo: '(e) CAMBIAR EL NÚMERO de campo: amount pasa de 2 a 5',
    proto: 'string id=1; string currency=3; int32 amount=5;',
    schema: [
      { campo: 1, nombre: 'id', tipo: 'string' },
      { campo: 3, nombre: 'currency', tipo: 'string' },
      { campo: 5, nombre: 'amount', tipo: 'int' },
    ],
    veredicto: (r) =>
      r.amount === 0
        ? '❌ ROTO — amount = 0. El importe real sigue viajando en el campo 2,\n            que este consumidor ya no conoce y descarta. Una orden de $1.499\n            se procesa como $0. No hay error: hay un default de proto3.'
        : '❌ algo salió mal',
  },
];

console.log(`\n${'='.repeat(72)}`);
console.log('  LOS CONSUMIDORES NUEVOS leen esos MISMOS bytes');
console.log('='.repeat(72));

for (const caso of CASOS) {
  const r = leerCon(caso.schema, bytes);
  console.log(`\n  ${caso.titulo}`);
  console.log(`  proto:  ${caso.proto}`);
  console.log(`  lee:    ${JSON.stringify(r)}`);
  console.log(`  ${caso.veredicto(r)}`);
}

console.log(`
${'='.repeat(72)}
  RESUMEN
${'='.repeat(72)}

  ✅ Agregar campo con número nuevo
  ✅ Renombrar (el nombre no viaja) — ojo con JSON y con la compilación
  ✅ int32 <-> int64 <-> uint32 <-> uint64 <-> bool <-> enum
  ❌ Cambiar el número de un campo         -> dato perdido, valor por defecto
  💀 Reusar un número borrado              -> corrupción SILENCIOSA

  Los dos últimos no lanzan ninguna excepción. Por eso 'reserved' no es
  una formalidad: es lo único que impide que alguien, dentro de dos años,
  cometa el caso (d) sin enterarse.

      reserved 3;
      reserved "currency";

  Y la regla que hace innecesario acordarse de todo esto:
  EXPAND / MIGRATE / CONTRACT. Nunca un cambio incompatible en un solo
  deploy. Agregar y escribir los dos campos -> migrar consumidores ->
  recién ahí borrar el viejo y marcarlo reserved.
`);

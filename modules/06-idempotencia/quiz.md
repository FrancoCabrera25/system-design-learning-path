# Cuestionario — Módulo 06

> Respondé en `mis-respuestas/06.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.
> Este módulo es tu tema: esperá repreguntas profundas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Qué es una operación idempotente?"* Definila correctamente (la
definición habitual está mal) y dame **un ejemplo de una operación que parece
idempotente y no lo es**.

**A2.** ¿Por qué la idempotencia es necesaria y no opcional? Partí del
**timeout ambiguo** y explicá por qué sólo hay dos opciones, no tres.

**A3.** Las tres formas de conseguir idempotencia. Para cada una: un ejemplo y
cuándo **no** sirve.

**A4.** ⏱️ *"¿Existe exactly-once?"* Respondé en 90 segundos. Incluí qué cubre
exactamente el exactly-once de Kafka y qué no.

**A5.** Diferencia entre **idempotente** y **seguro** (*safe*) en HTTP. ¿`PUT`
es cuál? ¿`DELETE`? ¿Por qué un `PUT` puede no ser idempotente en la práctica?

**A6.** Nombrá cuatro garantías de consistencia más fuertes que "eventual",
de menor a mayor, y para cada una un síntoma que el usuario ve cuando falta.

---

## Bloque B — Clave de idempotencia

**B1.** ¿Quién genera la `Idempotency-Key`: el cliente o el servidor?
Justificá. ¿Qué pasa si un interceptor de reintentos genera un `uuid()` nuevo
en cada intento?

**B2.** ¿Cuál es el **alcance** correcto de la clave? ¿Por qué usar sólo la
clave a secas es también un problema de **seguridad**?

**B3.** Para cada caso, decí qué devolvés y con qué código HTTP:
- (a) Clave nueva
- (b) Clave existente, `COMPLETED`, mismo request
- (c) Clave existente, `IN_PROGRESS`
- (d) Clave existente, **request distinto**
- (e) Clave existente, el intento anterior **falló**

**B4.** La fila `IN_PROGRESS`, ¿va dentro de la transacción que procesa el
pago o en una transacción propia? Justificá con lo que pasa bajo carga.

**B5.** ¿Cuánto tiempo guardás las claves? ¿Qué pasa si es muy corto? ¿Y si es
muy largo? ¿Cómo las limpiás sin que el borrado se convierta en un problema?

---

## Bloque C — Locks y coordinación

**C1.** ⏱️ *"¿Cómo implementás un lock distribuido con Redis?"* Escribí el
código. Después **criticá tu propia solución**: nombrá tres formas en que
falla.

**C2.** Un worker toma un lock con TTL de 10 s y sufre una pausa de GC de 15 s.
- (a) Contá la secuencia completa de lo que pasa.
- (b) ¿Lo arregla Redlock? Justificá.
- (c) ¿Lo arregla un TTL más largo?
- (d) ¿Qué lo arregla?

**C3.** ¿Qué es un **fencing token**? ¿Dónde vive la lógica que lo hace
funcionar? ¿Qué relación tiene con el lock optimista del módulo 05?

**C4.** *"¿Es por eficiencia o por corrección?"* Explicá por qué esa pregunta
va **antes** de elegir la implementación del lock, con un ejemplo de cada caso
de los módulos anteriores.

**C5.** Necesitás que un job corra en **una sola** instancia. Tres opciones,
ordenadas, con sus costos. ¿Por qué `pg_try_advisory_lock` es mejor que un
lock de Redis para esto? ¿Sigue haciendo falta que el job sea idempotente?

---

## Bloque D — Aplicado a tu stack ⏱️

**D1.** Tu cliente móvil hace `POST /pagos` y se corta el 4G. Reintenta.
Enumerá **todo** lo que tiene que existir —en el cliente, en la red, en el
servidor y en el proveedor de pagos— para que el usuario no pague dos veces.
Si falta **uno solo** de esos eslabones, ¿qué se rompe?

**D2.** Este consumer parece correcto. Encontrá el bug y arreglalo:

```ts
@EventPattern('order.created')
async handle(@Payload() ev: OrderCreated) {
  const ya = await this.repo.findOne({ where: { eventId: ev.eventId } });
  if (ya) return;

  await this.mailer.send(ev.email, 'Tu orden fue confirmada');
  await this.repo.save({ eventId: ev.eventId });
}
```

- (a) ¿Cuáles son los **dos** bugs distintos?
- (b) Arreglá el primero.
- (c) El segundo no se puede arreglar con una transacción. ¿Por qué? ¿Qué
      hacés?

**D3.** Tu consumer es idempotente por `eventId`. Kafka rebalancea y
reprocesa 5.000 mensajes. Todo bien. Ahora el handler, además de escribir en
Postgres, **llama a un LLM que cuesta USD 0,02**.
- (a) ¿Sigue estando todo bien? ¿Por qué?
- (b) ¿Cuánto cuesta el problema por año con 12 rebalances diarios?
- (c) Diseñá la solución.

**D4.** Diseñá la idempotencia del bucle de un agente de IA: recibe un
mensaje, llama a 0..N herramientas (algunas con efectos reales: mandar un
mail, crear un ticket, mover plata) y genera una respuesta. El pod se puede
reciclar en cualquier momento.
- ¿Qué clave lleva cada tool-call?
- ¿Cómo hacés que reanudar desde el paso 3 no re-ejecute los pasos 1 y 2?
- ¿Qué pasa si el LLM decide llamar la misma herramienta dos veces **a
  propósito**?
- ¿Qué patrón general estás reimplementando?

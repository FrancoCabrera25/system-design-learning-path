# Cuestionario — Módulo 02

> Respondé en `mis-respuestas/02.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son preguntas de entrevista reales: respondelas en voz alta,
> cronometradas, sin editar.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Cuándo usarías comunicación síncrona y cuándo asíncrona entre
microservicios?"* Respondé en 2 minutos, con un criterio que se pueda
aplicar sin ambigüedad (no "depende").

**A2.** Este código está en un servicio NestJS:

```ts
const user = await firstValueFrom(this.kafkaClient.send('user.get', { id }));
```

Un compañero dice: *"esto es asíncrono porque usa Kafka y `await`"*.
¿Tiene razón? Explicá por qué sí o por qué no, y qué consecuencia práctica
tiene esa respuesta sobre la disponibilidad del servicio.

**A3.** Enumerá **cinco** costos concretos de pasar una operación de
síncrona a asíncrona. No vale "es más complejo": nombrá los cinco problemas
específicos que aparecen y en qué módulo del path se resuelve cada uno.

**A4.** ¿Cuál es la diferencia entre un **timeout** y un **deadline** de
gRPC? ¿Por qué la distinción importa en una cadena `A → B → C`?

**A5.** ¿Qué es el **monolito distribuido**? Dame tres síntomas observables
(cosas que se puedan verificar mirando el repo o el pipeline, no
sensaciones) y el test de una sola pregunta que lo detecta.

---

## Bloque B — gRPC y contratos

**B1.** Explicá **dos** razones técnicas distintas por las que gRPC es más
rápido que REST/JSON. Una tiene que ser sobre el formato y la otra sobre el
transporte.

**B2.** Tenés este `.proto` en producción hace un año:

```protobuf
message Payment {
  string id       = 1;
  int32  amount   = 2;   // en centavos
  string currency = 3;
}
```

Para cada cambio, decí si es seguro y por qué. Si no lo es, decí **qué pasa
exactamente en producción** durante el rolling update:

- (a) Agregar `string description = 4;`
- (b) Renombrar `amount` a `amount_cents` (mismo número)
- (c) Cambiar `int32 amount = 2` a `int64 amount = 2`
- (d) Borrar `currency` y usar el número 3 para `string country = 3;`
- (e) Agregar un valor nuevo a un enum ya existente

**B3.** Desplegás un servicio gRPC en Kubernetes detrás de un `Service`
normal (ClusterIP). El HPA escala de 3 a 10 pods por CPU alta, pero la CPU
no baja y los 7 pods nuevos están al 2% de uso. ¿Qué está pasando? Dame la
causa y **dos** soluciones distintas.

**B4.** ⏱️ *"¿Por qué no usarían gRPC para todo?"* Dame cuatro casos
concretos donde REST/JSON es la mejor decisión.

**B5.** Un servicio gRPC cliente no configura deadline en ninguna llamada.
El servicio del que depende empieza a tardar 40 segundos en vez de 50 ms.
Describí la secuencia completa de lo que pasa en el cliente, paso por paso,
hasta que se cae. Usá la Ley de Little en la explicación.

---

## Bloque C — Diseño aplicado

**C1.** `POST /orders` tiene que: (A) validar stock, (B) cobrar con un
proveedor externo, (C) reservar envío, (D) mandar mail de confirmación, (E)
actualizar el índice de búsqueda, (F) registrar en analytics.

- (a) ¿Cuáles van sincrónicas y cuáles asíncronas? Justificá **cada una**
  con la pregunta "¿qué pasa si esto tarda 5 minutos?".
- (b) Con tu diseño, ¿cuál es el techo de disponibilidad si cada servicio
  tiene 99,9%?
- (c) El cobro (B) es un proveedor externo con SLA de 99,5% y p99 de 4
  segundos. ¿Lo dejás síncrono? ¿Qué hacés?

**C2.** Con tu diseño de C1, el usuario hace clic en "Comprar". ¿Qué le
mostrás en pantalla y **cuándo**? Detallá qué pasa si el pago se procesa
bien pero la reserva de envío falla 30 segundos después.

**C3.** El servicio de envíos estuvo caído 3 horas. Al volver, hay 40.000
eventos acumulados en el topic. Describí qué pasa cuando el consumer
arranca, y **tres** cosas que podrían salir mal si nadie diseñó para este
escenario.

**C4.** Tu servicio publica `order.created` con `emit()` justo después del
`await this.repo.save(order)`. El proceso se muere entre las dos líneas.
- (a) ¿Cuál es el estado del sistema?
- (b) ¿Cómo lo detectás?
- (c) ¿Cómo lo prevenís? Nombrá el patrón.
- (d) ¿Se puede resolver metiendo el `emit()` **dentro** de la transacción
  de base de datos? Justificá.

---

## Bloque D — Abierto ⏱️

**D1.** Un equipo propone partir el monolito en 12 microservicios de una
vez, con un plan de 6 meses. Sos el senior de la sala. ¿Qué preguntás, qué
proponés, y qué riesgo concreto nombrás?

**D2.** Diseñá la comunicación de un sistema de agentes de IA donde:
el usuario manda un mensaje, un agente decide llamar 0..N herramientas
(cada una es un microservicio distinto), y con esos resultados el agente
genera la respuesta final. La llamada al LLM tarda 3-40 s y cada
herramienta 50 ms-10 s.

- ¿Qué es síncrono y qué asíncrono?
- ¿Cómo le llegan los tokens al usuario?
- ¿Qué pasa si el usuario cierra el navegador a los 5 segundos?
- ¿Qué pasa si el mismo mensaje se procesa dos veces?

# Cuestionario — Módulo 07

> Respondé en `mis-respuestas/07.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.
> Kafka está en tu CV: esperá que bajen a profundidad.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Kafka o SQS?"* Respondé en 2 minutos. ¿Cuáles son las **dos**
razones reales para elegir Kafka, y por qué el throughput no es una de ellas?

**A2.** Explicá la diferencia entre una **cola** y un **log**. Nombrá tres
consecuencias prácticas de que el mensaje no se borre al consumirlo.

**A3.** ⏱️ *"¿Cómo garantizás el orden de los mensajes en Kafka?"* ¿Qué
perdés a cambio? ¿Por qué "orden global" es una respuesta incorrecta?

**A4.** ¿Qué es un **consumer group**? ¿Qué pasa si tenés 20 consumidores y 6
particiones? ¿Y 6 consumidores y 20 particiones?

**A5.** Diferencia entre `session.timeout.ms` y `max.poll.interval.ms`. ¿Por
qué un consumidor puede estar enviando heartbeats y aun así ser expulsado del
grupo?

**A6.** ¿Qué es **log compaction**? ¿Para qué sirve un **tombstone**? Dame un
caso de uso donde `cleanup.policy=compact` es correcto y otro donde sería un
error.

**A7.** ¿Qué hace exactamente `enable.idempotence=true` en el productor?
¿Te da idempotencia de negocio? Justificá.

---

## Bloque B — Particiones y claves

**B1.** Tu consumer procesa 1.200 msg/s y cada mensaje tarda 80 ms. El lag
crece. Escalás el deployment de 3 a 12 réplicas y **el lag no baja nada**.
- (a) ¿Cuál es la primera pregunta que hacés?
- (b) ¿Cuántas particiones necesitás? Mostrá la cuenta.
- (c) ¿Por qué el HPA puede **empeorar** la situación?
- (d) Tres palancas para arreglarlo, con el costo de cada una.

**B2.** Topic con 12 particiones y `key = tenantId`. Un tenant nuevo pasa a
ser el 50% del tráfico.
- (a) ¿Qué pasa?
- (b) ¿Lo arregla pasar a 96 particiones? Justificá.
- (c) ¿Por qué el lag **total** del grupo puede verse sano?
- (d) ¿Qué hacés? Dos opciones distintas.

**B3.** Para cada caso, decí qué clave usarías y qué orden te da:
- (a) Eventos de una orden de compra (`created`, `paid`, `shipped`)
- (b) Clicks de analytics, 50.000/s
- (c) Cambios de saldo de una cuenta bancaria
- (d) Mensajes de un chat
- (e) Eventos de un agente de IA conversacional

**B4.** ¿Por qué las particiones se pueden aumentar pero no reducir? ¿Qué se
rompe exactamente cuando las aumentás? ¿Cómo planificarías ese cambio?

**B5.** Dimensionás un topic nuevo hoy: 300 msg/s, 15 ms por mensaje. ¿Cuántas
particiones creás? Justificá el margen.

---

## Bloque C — Operación

**C1.** ⏱️ *"El consumer lag está creciendo. ¿Cómo lo diagnosticás?"* Dame
el orden exacto de las cosas que mirás, y qué descarta cada paso.

**C2.** Un mensaje tiene JSON corrupto y el handler lanza excepción siempre.
- (a) ¿Qué le pasa a su partición?
- (b) ¿Qué le pasa a los mensajes que vienen detrás?
- (c) ¿Por qué no alcanza con un `try/catch` que loguee y siga?
- (d) Diseñá la solución completa. Kafka no tiene DLQ nativa.

**C3.** El grupo rebalancea cada 5 minutos y el lag sube en línea recta. Los
pods están vivos y consumen CPU.
- (a) ¿Qué está pasando?
- (b) ¿Por qué el sistema no sale solo de ese estado?
- (c) Cinco formas de arreglarlo, ordenadas.
- (d) ¿Qué métrica habría avisado antes que el lag?

**C4.** Un rolling deploy de 24 pods consumidores. ¿Cuántos rebalances
dispara? ¿Cuántos mensajes deja de consumir el grupo? ¿Qué dos cambios de
**configuración** lo reducen drásticamente?

**C5.** `acks=1` vs `acks=all` vs `min.insync.replicas=2`. ¿Qué perdés con
cada configuración? Con RF=3, ¿cuál es la combinación que elegís y por qué?

---

## Bloque D — Diseño abierto ⏱️

**D1.** Necesitás **reprocesar 3 meses de eventos** para reconstruir una
proyección, sin afectar a los consumidores actuales y sin duplicar efectos.
- ¿Cómo lo hacés?
- ¿Qué pasa con el rate limit de la base mientras drenás 3 meses a máxima
  velocidad?
- ¿Y si el handler manda mails?

**D2.** Diseñá el pipeline de eventos de una plataforma de **agentes de IA**:
el usuario manda un mensaje, un worker llama a un LLM (3-40 s) y a 0..N
herramientas, y hay que persistir la traza.
- ¿Qué topics? ¿Qué claves? ¿Cuántas particiones?
- El proveedor del LLM te da 150 llamadas concurrentes. ¿Cómo no lo
  excedés?
- ¿Cómo autoescalás los consumidores?
- Un deploy a mitad de una generación de 40 segundos: ¿qué pasa?

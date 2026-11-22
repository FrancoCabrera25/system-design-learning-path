# Cuestionario — Módulo 08

> Respondé en `mis-respuestas/08.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Por qué un servicio degradado puede hacer más daño que uno
caído?"* 90 segundos.

**A2.** ¿Cómo elegís el valor de un timeout? ¿Cuál es el costo explícito de
bajarlo? Nombrá los **cuatro** timeouts distintos que hay que configurar en
una llamada a una base de datos.

**A3.** ⏱️ *"¿Por qué backoff con jitter y no backoff a secas?"* Explicá el
mecanismo, no sólo la recomendación.

**A4.** ¿Qué es un **retry budget** y por qué es mejor que "3 intentos por
request"? ¿Qué problema resuelve que el contador no puede resolver?

**A5.** Los tres estados de un circuit breaker. ¿A quién protege realmente un
circuit breaker? Nombrá **cuatro** errores de configuración comunes.

**A6.** Diferencia entre **bulkhead** y **circuit breaker**. ¿Son
alternativas? ¿Cuál es preventivo y cuál reactivo?

**A7.** ⏱️ ¿Qué es un **fallo metaestable**? ¿Por qué el sistema no vuelve
solo? Dame **tres** ejemplos de módulos anteriores de este path.

---

## Bloque B — Números

**B1.** Tu API llama a B, que llama a C, que llama a D. Cada capa reintenta 3
veces. D se cae.
- (a) ¿Cuántas llamadas recibe D por cada request de usuario?
- (b) Con 500 req/s de usuarios reales, ¿cuántas recibe D?
- (c) ¿Cómo lo arreglás **sin** sacar los reintentos? Dos formas.

**B2.** Timeout de 3 s y 3 reintentos con backoff de 1 s, 2 s, 4 s.
- (a) ¿Cuál es el peor caso de latencia total?
- (b) Si tu SLO de latencia es 2 s, ¿qué está mal en esa configuración?
- (c) ¿Cómo la corregís?

**B3.** 50.000 clientes fallan en el mismo instante por un reinicio. El
servicio aguanta 5.000 req/s al volver.
- (a) Con backoff exponencial **sin** jitter, ¿qué pasa en el segundo 1?
- (b) ¿Por qué el jitter hace que el sistema drene con **menos** trabajo
      total? (Es contraintuitivo: justificalo.)
- (c) ¿Por qué un backoff sin techo es un bug?

**B4.** Pool de 50 conexiones compartido. `/home` recibe 100 req/s y su
dependencia tarda 30 s, con timeout de 5 s.
- (a) ¿Cuántas conexiones necesitaría `/home`? Usá Little.
- (b) ¿Qué le pasa a `/checkout`, que no usa esa dependencia?
- (c) ¿Qué patrón lo habría evitado por completo y por qué?

---

## Bloque C — Aplicado a tu stack

**C1.** Este código está en producción. Encontrá **tres** problemas distintos:

```ts
async function cobrar(orden: Orden) {
  for (let i = 0; i < 5; i++) {
    try {
      return await this.http.post('https://pagos.externo.com/charge', orden);
    } catch (e) {
      await sleep(1000);
    }
  }
  throw new Error('No se pudo cobrar');
}
```

**C2.** Tu servicio NestJS llama a un LLM. El proveedor empieza a devolver
`429`.
- (a) ¿Qué hace tu código hoy, si no hiciste nada especial?
- (b) ¿Por qué reintentar inmediatamente es peor que no reintentar?
- (c) Diseñá el manejo correcto. ¿Qué header mirás?
- (d) ¿Qué rol juega el circuit breaker acá que no juega con una base de
      datos?

**C3.** Se cae Redis. Tu base aguanta 6.000 req/s y tenés 80.000 req/s.
- (a) ¿Qué pasa en el segundo 1?
- (b) ¿Por qué el sistema no se recupera solo cuando Redis vuelve?
- (c) Ordená las defensas por relación beneficio/esfuerzo.

**C4.** Tu `livenessProbe` hace `SELECT 1` contra Postgres. La base tiene un
hipo de 30 segundos.
- (a) Contá la secuencia completa.
- (b) ¿Por qué esto convierte una degradación en una caída total?
- (c) ¿Cuál es la regla para liveness vs readiness?

---

## Bloque D — Diseño abierto ⏱️

**D1.** Tu sistema se recuperó de un pico de tráfico hace 30 minutos. El
tráfico está normal. **Y sigue devolviendo 500.**
- ¿Qué está pasando? Nombralo.
- ¿Por qué no sale solo?
- Sos quien está de guardia a las 3 AM: ¿cuál es el **orden exacto** de lo
  que hacés para sacarlo del estado malo?
- ¿Qué cambiarías después para que no vuelva a pasar?

**D2.** Diseñá la estrategia de fiabilidad completa de un endpoint
`POST /orders` que llama a: stock (interno, 20 ms), pagos (externo, p99 4 s,
SLA 99,5%) y envíos (interno, 50 ms).
- Timeout de cada uno, con el criterio.
- ¿Dónde reintentás y dónde no?
- ¿Dónde ponés breakers? ¿Con qué fallback cada uno?
- ¿Cómo aislás los recursos?
- ¿Cuál es el presupuesto total de latencia y cómo lo repartís?

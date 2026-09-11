# Cuestionario — Módulo 04

> Respondé en `mis-respuestas/04.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿Qué es un cache stampede y cómo lo evitás?"* 2 minutos, con el
mecanismo y al menos tres defensas distintas.

**A2.** Explicá la diferencia entre **cache-aside**, **write-through** y
**write-behind**. Para cada uno: un caso donde es la elección correcta y el
riesgo concreto que asumís.

**A3.** ⏱️ *"¿Por qué la invalidación de caché es difícil?"* No repitas el
chiste de Phil Karlton: dame **tres** razones técnicas concretas.

**A4.** ¿Qué es *cache penetration* y en qué se diferencia de un stampede?
¿Por qué un atacante podría usarlo? Dos defensas.

**A5.** ¿Cuándo `allkeys-lru` y cuándo `allkeys-lfu`? Dame el escenario
específico donde la diferencia es dramática.

**A6.** Tenés caché local en cada pod (un `Map`) **y** Redis. ¿Qué ganás?
¿Qué problema nuevo creás? ¿Qué tipo de dato puede ir en el nivel local y
cuál no?

---

## Bloque B — Números

**B1.** API de 80.000 req/s, caché con 99% de hit rate, la base aguanta
6.000 req/s.
- (a) ¿Cuántas req/s recibe la base normalmente?
- (b) Un deploy cambia el formato de serialización y el hit rate cae a 92%.
      ¿Cuántas recibe ahora? ¿Sobrevive?
- (c) ¿Qué métrica habría avisado **antes**? ¿Sobre qué alertarías
      exactamente?

**B2.** Una clave caliente se lleva el 15% del tráfico. 20.000 req/s, la
query tarda 80 ms, TTL 300 s.
- (a) Sin protección, ¿cuántas queries simultáneas se disparan cuando expira?
- (b) ¿Cuánto ayuda agregarle jitter al TTL? Justificá.
- (c) Escribí el single-flight con Redis. ¿Qué pasa si el pod que ganó el
      lock se muere antes de escribir el caché?

**B3.** Se cae Redis por completo durante 4 minutos. 80.000 req/s, la base
aguanta 6.000.
- (a) ¿Qué pasa en el segundo 1?
- (b) Cuando Redis vuelve, ¿el sistema se recupera solo? Justificá.
- (c) ¿Qué habría que tener implementado para que esto fuera una
      degradación y no una caída?

**B4.** Cluster de caché de 6 nodos con consistent hashing y 150 vnodos.
Se cae uno.
- (a) ¿Qué fracción de claves se pierde?
- (b) Los 5 restantes tienen que absorber esas claves. ¿Qué pasa si estaban
      al 85% de memoria?
- (c) ¿Cómo se relaciona esto con el `maxmemory-policy`?

---

## Bloque C — Aplicado a tu stack

**C1.** Cacheás el perfil del usuario con TTL de 5 minutos. El usuario
cambia su foto y no la ve.
- (a) Tres soluciones distintas, con su costo.
- (b) Ahora la app tiene 40 pods con caché local además de Redis. ¿Cuál de
      las tres sigue funcionando?

**C2.** Este código tiene un bug de concurrencia que no lanza ningún error.
Encontralo, explicá la secuencia exacta, y proponé dos arreglos.

```ts
async getUser(id: string) {
  const cached = await this.redis.get(`user:${id}`);
  if (cached) return JSON.parse(cached);
  const user = await this.repo.findOne(id);
  await this.redis.set(`user:${id}`, JSON.stringify(user), 'EX', 300);
  return user;
}

async updateUser(id: string, dto: UpdateDto) {
  const user = await this.repo.update(id, dto);
  await this.redis.del(`user:${id}`);
  return user;
}
```

**C3.** Un endpoint devuelve un objeto de 8 MB y lo cacheás en Redis.
Nombrá **tres** problemas distintos que esto genera en un servicio NestJS,
uno de ellos específico de Node.

**C4.** Diseñá el caché de un sistema de agentes de IA donde cada llamada al
LLM cuesta USD 0,02 y tarda 6 segundos.
- ¿Qué cachearías exactamente? (la respuesta no es "la respuesta")
- ¿Cuál es la clave? ¿Por qué el texto exacto del prompt no sirve?
- ¿Qué riesgo tiene cachear respuestas de un LLM que no existe en un caché
  de base de datos?

---

## Bloque D — Diseño abierto ⏱️

**D1.** Diseñá el caché del **feed** de una red social con 5M DAU. Cada
usuario ve un feed personalizado de 50 publicaciones. Una publicación de un
usuario con 3 millones de seguidores aparece en 3 millones de feeds.
- ¿Cacheás el feed armado o las publicaciones sueltas?
- *Fan-out on write* vs *fan-out on read*: ¿cuál elegís y por qué?
- ¿Qué hacés con las cuentas con millones de seguidores?
- ¿Cuánta memoria necesitás? Estimá.

**D2.** Un compañero propone: *"cacheemos todo con TTL de 1 hora, así la
base no sufre"*. ¿Qué preguntás antes de aceptar o rechazar? Nombrá dos
casos del sistema donde eso sería un bug grave.

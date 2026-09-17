# Cuestionario — Módulo 05

> Respondé en `mis-respuestas/05.md` **sin abrir `respuestas.md`**.
> Las ⏱️ son de entrevista: en voz alta y cronometradas.

---

## Bloque A — Conceptos

**A1.** ⏱️ *"¿SQL o NoSQL?"* Respondé en 2 minutos con un criterio aplicable,
no con "depende". ¿Cuál es la pregunta que de verdad decide, y por qué la
categoría SQL/NoSQL es una mala forma de plantearlo?

**A2.** Explicá qué es un `Index Only Scan` y por qué es tan superior a un
`Index Scan`. ¿Cómo hacés que una query lo use?

**A3.** ⏱️ *"¿Por qué agregar un índice puede hacer más lenta tu aplicación?"*
Cuatro razones distintas.

**A4.** Nombrá las cuatro letras de ACID y explicá por qué la "I" es la única
que tiene grados. ¿Cuál es el nivel por defecto de Postgres y qué anomalías
deja pasar?

**A5.** Diferencia entre **lost update** y **write skew**. ¿Por qué un
`SELECT ... FOR UPDATE` sobre la fila que vas a modificar resuelve uno y no
el otro?

**A6.** ¿Qué es MVCC? Explicá por qué en Postgres un `UPDATE` es casi tan caro
como un `INSERT`, y por qué una transacción abierta durante 40 minutos puede
degradar tablas que esa transacción ni toca.

**A7.** ⏱️ Explicá **CAP** en 90 segundos. ¿Por qué "elijo CA" es una
respuesta incorrecta? ¿Qué agrega **PACELC** y por qué es más útil en la
práctica?

---

## Bloque B — Índices y queries

**B1.** Esta query es la más usada de tu sistema:

```sql
SELECT id, total, estado FROM ordenes
WHERE tenant_id = $1 AND estado = 'PENDIENTE'
ORDER BY created_at DESC
LIMIT 20;
```

- (a) ¿Qué índice creás? Escribilo, con el orden exacto de las columnas.
- (b) ¿Por qué ese orden y no otro?
- (c) ¿Cómo lo convertís en `Index Only Scan`?
- (d) `estado` tiene 4 valores posibles y el 85% de las filas son
      `'COMPLETADA'`. ¿Conviene indexar `estado`? ¿Qué harías en su lugar?

**B2.** Tenés `INDEX (tenant_id, created_at)`. Para cada query, decí si usa
el índice, sólo un prefijo, o nada — y por qué:
- (a) `WHERE tenant_id = 5 AND created_at > '2026-01-01'`
- (b) `WHERE tenant_id = 5`
- (c) `WHERE created_at > '2026-01-01'`
- (d) `WHERE tenant_id IN (5, 9) ORDER BY created_at DESC`
- (e) `WHERE lower(email) = 'a@b.com'` con `INDEX (email)`

**B3.** Una tabla de 200M filas tiene 11 índices. El equipo quiere agregar
dos más "por las dudas".
- (a) ¿Cuántas escrituras genera hoy un `INSERT`?
- (b) ¿Cómo averiguás cuáles de los 11 no se usan?
- (c) ¿Cuáles **no** podés borrar aunque `idx_scan = 0`?

**B4.** Un `EXPLAIN ANALYZE` muestra `Seq Scan` sobre una tabla de 50M filas,
con un índice que parece aplicable. Dame **cuatro** causas posibles.

---

## Bloque C — Concurrencia y consistencia

**C1.** Este código está en producción:

```ts
const producto = await repo.findOne({ where: { id } });
if (producto.stock <= 0) throw new ConflictException('Sin stock');
producto.stock -= 1;
await repo.save(producto);
```

- (a) ¿Qué bug tiene? Describí la secuencia exacta con dos requests.
- (b) ¿Lo arregla envolverlo en una transacción? Justificá.
- (c) Escribí **tres** arreglos distintos y decí cuándo usar cada uno.
- (d) Con 500 compradores simultáneos y stock 100, ¿cuántas unidades
      vendés con el código de arriba?

**C2.** ⏱️ Dos requests con la misma `Idempotency-Key` llegan **al mismo
tiempo** a dos pods distintos. El código hace `SELECT` de la clave y, si no
existe, `INSERT` + procesa.
- (a) ¿Qué pasa con `READ COMMITTED`?
- (b) ¿Lo arregla `SERIALIZABLE`? ¿A qué costo?
- (c) ¿Cuál es la solución correcta y por qué no depende del nivel de
      aislamiento?
- (d) La segunda request llega cuando la primera **todavía está
      procesando**. ¿Qué le devolvés?

**C3.** Tu servicio tiene deadlocks intermitentes (`40P01`) en una operación
que actualiza varias filas.
- (a) ¿Cuál es la causa casi segura?
- (b) ¿Cómo la arreglás, con una regla que valga para todo el código?
- (c) ¿Podés eliminarlos por completo? Si no, ¿qué tiene que hacer la app?

**C4.** El usuario dice que "a veces no se guarda" su perfil. No hay errores
en los logs. El `POST` devuelve 200.
- (a) ¿Qué está pasando?
- (b) ¿Por qué el equipo no lo puede reproducir a mano?
- (c) Cuatro soluciones, ordenadas por costo.
- (d) ¿Qué alerta habría que tener?

---

## Bloque D — Operación y diseño ⏱️

**D1.** Tenés que agregar una columna `country` a `usuarios` (80M filas),
poblarla desde otra tabla, hacerla `NOT NULL` y crear un índice. La app no
puede tener downtime.
- Escribí el plan completo, paso por paso, diciendo qué deploy va en cada uno.
- ¿Cuál de esas operaciones bloquea y cómo lo evitás?
- ¿Por qué un `ALTER TABLE` instantáneo puede igual frenar la tabla 30
  segundos? ¿Qué le ponés adelante?

**D2.** Diseñá el esquema y la estrategia de datos de un sistema de
**auditoría**: cada acción de cada usuario se registra, 200M eventos/mes, hay
que retener 7 años por compliance, y las consultas habituales son "todo lo
que hizo el usuario X en los últimos 30 días".
- ¿Qué motor(es)?
- ¿Particionás? ¿Por qué columna?
- ¿Qué índices?
- ¿Qué pasa con los datos de hace 5 años?
- ¿Cómo hacés que el borrado por compliance (GDPR: "borrá todo de este
  usuario") no sea un infierno?

---
"@effect/sql-pg": patch
"effect": patch
---

Replace `@effect/sql-pg`'s `pg` runtime with a native PostgreSQL client. `PgConnection` and `PgPool` now handle connection setup, binary queries, prepared statements, pipelining, streaming, notifications, cancellation, and custom codecs. `PgConnection.listen` and `PgClient.listen` return scoped notification dequeues after PostgreSQL confirms the subscription. `PgClient` uses the native stack, and the legacy `fromPool`, `fromClient`, and `makeWith` constructors are removed.

### Breaking changes

- `fromPool`, `fromClient`, and `makeWith` are removed. Use `make` for a pool or `makeClient` for one connection.
- `PgClient.listen` returns a scoped `Effect<Dequeue<string>, SqlError, Scope>` instead of a `Stream`. Acquisition completes after PostgreSQL confirms `LISTEN`, so notifications sent after it returns cannot be missed.
- `PgClientConfig.types` now accepts a `PgTypes.Registry` instead of `pg.CustomTypesConfig`. Plain object parameters are no longer inferred as JSON; wrap them with `sql.json`.
- Query strings must contain one statement. PostgreSQL's extended protocol rejects multi-statement strings.
- Results use the native binary codecs. In particular, `int8` decodes to `bigint`, `date` to a string, timestamps to Unix epoch milliseconds, and `bytea` or unknown OIDs to `Uint8Array`. `executeRaw` returns the native `PgConnection.Result` shape rather than `pg.Result`.
- Named prepared statements are enabled by default. Set `prepare: false` when using a pooler that cannot preserve prepared statements between queries. `Statement.unprepared` and `Statement.valuesUnprepared` use unnamed extended queries without adding entries to the prepared-statement cache.

Inferred parameters stay permissive: strings bind untyped so the backend derives the type from the statement, and safe integers beyond the `int4` range bind as `int8`.

Add `Pool.reserve` for exclusive access to a concurrent pool item, and fix waiter wakeups and capacity replacement after invalidation.

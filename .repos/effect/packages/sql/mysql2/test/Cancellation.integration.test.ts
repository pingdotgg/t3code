import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { MysqlContainer } from "./utils.ts"

// Every test uses a pool of one connection, so a statement or lease left
// behind by an interrupted fiber blocks the follow-up query.
const singleConnection = MysqlContainer.clientWith({ maxConnections: 1 })

it.layer(MysqlContainer.layer, { timeout: "90 seconds", excludeTestServices: true })((it) => {
  it.effect("interrupting a running statement kills it", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const slow = yield* sql`SELECT SLEEP(10)`.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep("200 millis")

      const rows = yield* Fiber.interrupt(slow).pipe(
        Effect.andThen(sql<{ running: number }>`
          SELECT COUNT(*) AS running FROM information_schema.processlist WHERE info = 'SELECT SLEEP(10)'
        `),
        Effect.timeout("2 seconds")
      )
      assert.deepStrictEqual(rows, [{ running: 0 }])
    }).pipe(Effect.provide(singleConnection)), { timeout: 30_000 })

  it.effect(
    "interrupting a pending reservation returns promptly and releases the late connection",
    () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const busy = yield* sql`SELECT SLEEP(3)`.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("200 millis")
        const waiting = yield* Effect.scoped(sql.reserve).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Fiber.interrupt(waiting).pipe(Effect.timeout("1 second"))

        yield* Fiber.join(busy)
        const rows = yield* sql<{ value: number }>`SELECT 1 AS value`.pipe(Effect.timeout("2 seconds"))
        assert.deepStrictEqual(rows, [{ value: 1 }])
      }).pipe(Effect.provide(singleConnection)),
    { timeout: 30_000 }
  )

  it.effect("ending a stream early stops the statement", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      // Rows arrive before the server reaches the SLEEP, so the stream can end
      // while the statement is still running.
      const [rows, next] = yield* Effect.all([
        sql`
          WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
          SELECT /*+ SET_VAR(cte_max_recursion_depth = 100000) */ n, IF(n = 100000, SLEEP(10), 0) AS slept FROM seq
        `.stream.pipe(Stream.take(5), Stream.runCollect),
        sql<{ value: number }>`SELECT 1 AS value`
      ]).pipe(Effect.timeout("2 seconds"))
      assert.strictEqual(rows.length, 5)
      assert.deepStrictEqual(next, [{ value: 1 }])
    }).pipe(Effect.provide(singleConnection)), { timeout: 30_000 })

  it.effect(
    "ending a stream whose remaining rows are already buffered keeps the connection",
    () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        // While the slow consumer holds the first row, the rest of a result of
        // this size arrives and waits in mysql2's paused packet buffer. Ending
        // the stream replays it, so the statement finishes during cleanup.
        for (const size of [1400, 1500, 1600, 1700]) {
          const [before, after] = yield* Effect.all([
            sql<{ id: number }>`SELECT CONNECTION_ID() AS id`,
            sql`
            WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${size})
            SELECT /*+ SET_VAR(cte_max_recursion_depth = 100000) */ n, REPEAT('x', 100) AS padding FROM seq
          `.stream.pipe(
              Stream.mapEffect((row) => Effect.as(Effect.sleep("200 millis"), row)),
              Stream.take(1),
              Stream.runCollect
            ),
            sql<{ id: number }>`SELECT CONNECTION_ID() AS id`
          ]).pipe(
            Effect.map(([before, _, after]) => [before, after] as const),
            Effect.timeout("2 seconds")
          )
          assert.deepStrictEqual(after, before)
        }
      }).pipe(Effect.provide(singleConnection)),
    { timeout: 30_000 }
  )

  it.effect(
    "a stream consumer can run statements on the same connection once the streamed statement ends",
    () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql.withTransaction(
          sql`SELECT 1 AS value`.stream.pipe(
            Stream.mapEffect(() => sql<{ value: number }>`SELECT 2 AS value`),
            Stream.runCollect
          )
        ).pipe(Effect.timeout("2 seconds"))
        assert.deepStrictEqual(rows, [[{ value: 2 }]])
      }).pipe(Effect.provide(singleConnection)),
    { timeout: 30_000 }
  )

  it.effect(
    "interrupting a statement queued on a shared connection leaves the running one alone",
    () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE cancel_queued (id INT)`
        const first = yield* sql.withTransaction(Effect.gen(function*() {
          const running = yield* sql<{ first: number }>`SELECT SLEEP(1) AS first`.pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.sleep("200 millis")
          const queued = yield* sql`INSERT INTO cancel_queued VALUES (1)`.pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(queued)
          return yield* Fiber.join(running)
        }))
        // SLEEP returns 1 when it is killed and 0 when it runs to completion.
        assert.deepStrictEqual(first, [{ first: 0 }])
        assert.deepStrictEqual(yield* sql`SELECT id FROM cancel_queued`, [])
      }).pipe(Effect.provide(singleConnection)),
    { timeout: 30_000 }
  )
})

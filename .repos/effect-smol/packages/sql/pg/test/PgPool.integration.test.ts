import { PgConnection, PgPool } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Queue, Redacted, Stream } from "effect"
import { PgContainer } from "./utils.ts"

// `it.effect` runs under the TestClock, so poll loops sleep in real time.
const realSleep = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

const poolConfig = Effect.gen(function*() {
  const container = yield* PgContainer
  return { url: Redacted.make(container.getConnectionUri()) }
})

it.layer(PgContainer.layer, { timeout: "30 seconds" })("PgPool", (it) => {
  it.effect("reuses checked out connections", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1 })
      const checkout = Effect.scoped(Effect.gen(function*() {
        const connection = yield* pool.get
        const result = yield* connection.query("SELECT $1::int4 AS one", [1])
        assert.deepStrictEqual(result.rows, [{ one: 1 }])
        return connection.processId
      }))
      const first = yield* checkout
      const second = yield* checkout
      assert.strictEqual(first, second)
    }))

  it.effect("uses a connection once when its TTL is zero", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), connectionTTL: 0, maxConnections: 1 })
      const checkout = Effect.scoped(Effect.map(pool.get, (connection) => connection.processId)).pipe(
        Effect.timeout("1 second")
      )
      const first = yield* checkout
      const second = yield* checkout
      assert.notStrictEqual(first, second)
    }))

  it.effect("streams rows incrementally and cancels on early abort", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make(yield* poolConfig)
      const connection = yield* pool.get
      const rows = yield* Stream.runCollect(
        connection.stream("SELECT n FROM generate_series(1, $1::int4) AS g(n)", [1000])
      )
      assert.strictEqual(rows.length, 1000)
      assert.deepStrictEqual(rows[0], { n: 1 })
      assert.deepStrictEqual(rows[999], { n: 1000 })

      const aborted = yield* Stream.runCollect(
        connection.stream("SELECT n FROM generate_series(1, 1000000) AS g(n)").pipe(Stream.take(5))
      )
      assert.deepStrictEqual(aborted, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }])

      // The connection survives the cancelled stream.
      const result = yield* connection.query("SELECT $1::text AS after", ["ok"])
      assert.deepStrictEqual(result.rows, [{ after: "ok" }])
    }))

  it.effect("acquires a multiplexed listener after registration", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 2, multiplex: true })
      const listener = yield* pool.reserve
      const notifications = yield* listener.listen("test_channel")
      const notifier = yield* pool.get
      assert.notStrictEqual(listener.processId, notifier.processId)
      yield* notifier.query("SELECT pg_notify($1, $2)", ["test_channel", "hello"])
      const notification = yield* Queue.take(notifications)
      assert.strictEqual(notification.channel, "test_channel")
      assert.strictEqual(notification.payload, "hello")
      assert.strictEqual(notification.processId, notifier.processId)
    }))

  it.effect("reports listener registration failure during acquisition", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1 })
      const connection = yield* pool.get
      yield* connection.query("BEGIN")
      yield* Effect.flip(connection.query("SELECT * FROM effect_missing_relation"))

      const error = yield* Effect.flip(connection.listen("test_channel"))
      assert.strictEqual(error._tag, "SqlError")

      // A failed acquisition must release the connection pin.
      yield* connection.query("ROLLBACK")
      const result = yield* connection.query("SELECT 1 AS one")
      assert.deepStrictEqual(result.rows, [{ one: 1 }])
    }))

  it.effect("returns a multiplexed reservation to shared circulation", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1, multiplex: true })
      const reserve = Effect.scoped(Effect.map(pool.reserve, (connection) => connection.processId))
      const get = Effect.scoped(Effect.map(pool.get, (connection) => connection.processId))

      const first = yield* reserve
      assert.strictEqual(yield* get, first)
      assert.strictEqual(yield* reserve, first)
      assert.strictEqual(yield* get, first)
    }))

  it.effect("interrupt cancels an in-flight query", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make(yield* poolConfig)
      const connection = yield* pool.get
      const other = yield* pool.get
      const fiber = yield* Effect.forkScoped(connection.query("SELECT pg_sleep(10)"))
      // Wait until the statement is running server side.
      while (true) {
        const active = yield* other.query(
          "SELECT count(*)::int4 AS active FROM pg_stat_activity WHERE pid = $1 AND state = 'active'",
          [connection.processId]
        )
        if (active.rows[0].active === 1) break
        yield* realSleep
      }
      yield* connection.interrupt
      const error = yield* Effect.flip(Fiber.join(fiber))
      assert.strictEqual(error._tag, "SqlError")
      assert.strictEqual(error.reason._tag, "StatementTimeoutError")

      // The connection survives the cancelled statement.
      const result = yield* connection.query("SELECT $1::int4 AS after", [2])
      assert.deepStrictEqual(result.rows, [{ after: 2 }])
    }))

  it.effect("replaces connections that die", () =>
    Effect.gen(function*() {
      const config = yield* poolConfig
      const pool = yield* PgPool.make({ ...config, maxConnections: 1 })
      const first = yield* Effect.scoped(Effect.map(pool.get, (connection) => connection.processId))
      const terminator = yield* PgConnection.make(config)
      yield* terminator.query("SELECT pg_terminate_backend($1)", [first])
      // The pool notices the dead connection asynchronously; retry until it
      // hands out a healthy replacement.
      while (true) {
        const replaced = yield* Effect.scoped(Effect.gen(function*() {
          const connection = yield* pool.get
          const alive = yield* Effect.isSuccess(connection.query("SELECT 1 AS one"))
          return alive && connection.processId !== first ? connection.processId : undefined
        }))
        if (replaced !== undefined) {
          assert.notStrictEqual(replaced, first)
          break
        }
        yield* realSleep
      }
    }))
  it.effect("defaults multiplex concurrency to 32", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 4, multiplex: true })
      const processIds = yield* Effect.all(
        Array.from({ length: 32 }, () =>
          Effect.scoped(Effect.flatMap(pool.get, (connection) =>
            Effect.as(
              connection.query("SELECT pg_sleep(0.05)"),
              connection.processId
            )))),
        { concurrency: "unbounded" }
      )
      assert.strictEqual(new Set(processIds).size, 1)
    }))
  it.effect("invalidates a reserved connection", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 2, multiplex: true })
      const reserved = yield* pool.reserve
      yield* pool.invalidate(reserved)
      const replacement = yield* pool.get
      assert.notStrictEqual(replacement.processId, reserved.processId)
    }))

  it.effect("keeps a multiplexed stream's connection to itself", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 2, multiplex: true })
      const connection = yield* pool.get
      // A stream pins its connection for its lifetime. A checkout that landed
      // on the same one would wait behind a stream only it could drain.
      const doubled = yield* connection.stream("SELECT generate_series(1, 5) AS n").pipe(
        Stream.mapEffect((row) =>
          Effect.flatMap(pool.get, (other) => other.query("SELECT $1::int4 AS d", [(row as any).n * 2]))
        ),
        Stream.map((result) => (result.rows[0] as any).d),
        Stream.runCollect
      )
      assert.deepStrictEqual(Array.from(doubled), [2, 4, 6, 8, 10])
    }))
  it.effect("admits a waiting checkout when a reserved connection dies", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1, multiplex: true })
      const reserved = yield* pool.reserve
      const waiter = yield* Effect.forkScoped(
        Effect.scoped(Effect.flatMap(pool.get, (connection) => connection.query("SELECT 1 AS ok")))
      )
      yield* realSleep

      // The reservation is still held when its connection dies, so nothing
      // returns the connection to the pool. The waiter behind it would queue
      // for a connection that is never coming back.
      yield* Effect.ignore(reserved.query("SELECT pg_terminate_backend(pg_backend_pid())"))

      const result = yield* Fiber.join(waiter)
      assert.deepStrictEqual(result.rows, [{ ok: 1 }])
    }))
  it.effect("returns a borrowed session on success, failure, and interruption", () =>
    Effect.gen(function*() {
      // A pool of one: a lease that is not returned hangs the next borrow.
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1 })
      const borrow = <A, E>(effect: (connection: PgConnection.PgConnection) => Effect.Effect<A, E>) => pool.use(effect)

      assert.deepStrictEqual(
        (yield* borrow((connection) => connection.query("SELECT 1 AS ok"))).rows,
        [{ ok: 1 }]
      )

      const failed = yield* Effect.result(borrow((connection) => connection.query("SELECT * FROM nope")))
      assert.strictEqual(failed._tag, "Failure")

      const running = yield* Effect.forkScoped(borrow((connection) => connection.query("SELECT pg_sleep(30)")))
      yield* realSleep
      yield* Fiber.interrupt(running)

      assert.deepStrictEqual(
        (yield* borrow((connection) => connection.query("SELECT 2 AS ok"))).rows,
        [{ ok: 2 }]
      )
    }), 20_000)

  it.effect("borrows around a connection that has to be replaced", () =>
    Effect.gen(function*() {
      const pool = yield* PgPool.make({ ...(yield* poolConfig), maxConnections: 1 })
      const first = yield* pool.use((connection) => Effect.as(connection.query("SELECT 1 AS ok"), connection.processId))
      // Killing the only session leaves it queued dead, which is exactly the
      // case the fast path declines to take. The backend answers with an error
      // and closes afterwards, so wait for the close to land before borrowing
      // again - both paths would race it otherwise.
      yield* Effect.ignore(
        pool.use((connection) => connection.query("SELECT pg_terminate_backend(pg_backend_pid())"))
      )
      for (let i = 0; i < 50; i++) yield* realSleep
      const second = yield* pool.use((connection) =>
        Effect.as(connection.query("SELECT 2 AS ok"), connection.processId)
      )
      assert.notStrictEqual(second, first)
    }), 20_000)
  it.effect("honours a configured multiplex concurrency", () =>
    Effect.gen(function*() {
      // Two statements to a connection means eight of them need four
      // connections, where the default for a pool this size would fit them on
      // one.
      const pool = yield* PgPool.make({
        ...(yield* poolConfig),
        maxConnections: 4,
        multiplex: true,
        multiplexConcurrency: 2
      })
      const processIds = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          Effect.scoped(Effect.flatMap(pool.get, (connection) =>
            Effect.as(connection.query("SELECT pg_sleep(0.05)"), connection.processId)))),
        { concurrency: "unbounded" }
      )
      assert.strictEqual(new Set(processIds).size, 4)
    }))
})

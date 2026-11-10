import { MysqlClient } from "@effect/sql-mysql2"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import * as Arr from "effect/Array"
import * as Scheduler from "effect/Scheduler"
import * as Mysql from "mysql2"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { vi } from "vitest"

import { MysqlContainer } from "./utils.ts"

vi.mock("mysql2", { spy: true })

describe("MysqlClient", () => {
  it.effect("stream returns same rows as direct execution", () =>
    Effect.gen(function*() {
      const sql = yield* MysqlClient.MysqlClient

      yield* sql`DROP TABLE IF EXISTS stream_regression_test`
      yield* sql`CREATE TABLE stream_regression_test (id INT PRIMARY KEY AUTO_INCREMENT, value VARCHAR(255))`

      const testData = Array.from({ length: 100 }, (_, i) => ({ value: `row_${i}` }))
      assert(Arr.isArrayNonEmpty(testData))
      yield* sql`INSERT INTO stream_regression_test ${sql.insert(testData)}`

      const directResults = yield* sql`SELECT * FROM stream_regression_test`

      const streamResults = yield* Stream.runCollect(
        sql`SELECT * FROM stream_regression_test`.stream
      )

      yield* sql`DROP TABLE stream_regression_test`

      assert.strictEqual(
        streamResults.length,
        directResults.length,
        `Stream returned ${streamResults.length} rows, expected ${directResults.length}`
      )
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  // These replace mysql2's pool with fakes through one-shot mocks, so they
  // must not run alongside each other.
  describe("with a fake mysql2 pool", { concurrent: false }, () => {
    it.effect("uses query when prepared statements are disabled", () =>
      Effect.gen(function*() {
        const calls: Array<"execute" | "query"> = []
        const query = (options: string | object, callback: (cause: null, rows?: Array<unknown>) => void) => {
          if (typeof options !== "string") {
            calls.push("query")
          }
          callback(null, [])
        }
        const conn = {
          threadId: 1,
          query,
          execute: (_options: object, callback: (cause: null, rows: Array<unknown>) => void) => {
            calls.push("execute")
            callback(null, [])
          },
          release: () => {}
        }
        vi.mocked(Mysql.createPool).mockReturnValueOnce({
          query,
          getConnection: (callback: (cause: null, conn: unknown) => void) => callback(null, conn),
          end: (callback: () => void) => callback()
        } as unknown as Mysql.Pool)

        yield* Effect.gen(function*() {
          const sql = yield* MysqlClient.MysqlClient
          yield* sql`SELECT ${1}`
          yield* sql`SELECT ${1}`.values
          yield* sql.unsafe("SELECT ?", [1]).raw
        }).pipe(Effect.provide(MysqlClient.layer({ disablePreparedStatements: true })))

        assert.deepStrictEqual(calls, ["query", "query", "query"])
      }))

    it.live(
      "keeps the connection when a cancelled stream settles before its kill is registered",
      () =>
        Effect.gen(function*() {
          // The yield budget decides where the fiber yields. Small budgets put a
          // yield between deciding to cancel the stream's statement and
          // registering for its settlement, which is where the statement ends.
          for (const maxOpsBeforeYield of [3, 4, 5, 6, 7, 8]) {
            const log = yield* cancelSettlingStream(maxOpsBeforeYield)
            // A kill that reaches the server while the queued statement runs
            // interrupts that statement instead.
            const kill = log.indexOf("kill 7")
            assert.isTrue(
              kill === -1 || kill < log.indexOf("start SELECT 2 AS value"),
              `budget ${maxOpsBeforeYield}: ${log.join(", ")}`
            )
            assert.notInclude(log, "connection destroyed", `budget ${maxOpsBeforeYield}`)
          }
        }),
      { timeout: 60_000 }
    )

    it.live("kills a stream's statement when interrupted before the first row", () =>
      Effect.gen(function*() {
        // As above, small budgets put a yield right after the statement starts,
        // which is where the stream is interrupted.
        for (const maxOpsBeforeYield of [3, 4, 5, 6, 7, 8]) {
          const log = yield* interruptStreamSetup(maxOpsBeforeYield)
          // The connection is only reused once the streamed statement has ended.
          const end = log.indexOf("stream end")
          assert.isTrue(
            end !== -1 && end < log.indexOf("start SELECT 2 AS value"),
            `budget ${maxOpsBeforeYield}: ${log.join(", ")}`
          )
        }
      }), { timeout: 60_000 })

    it.live("gives a shared connection back when the kill connection cannot be created", () =>
      Effect.gen(function*() {
        const log: Array<string> = []
        const command = Object.assign(new EventEmitter(), {
          stream: () => {
            // Unless it is killed, the statement ends on its own after 100 ms.
            setTimeout(() => command.emit("end"), 100)
            return new Readable({ objectMode: true, read() {} })
          }
        })
        // mysql2 calls a configured `stream` factory while constructing the
        // connection, so creating the kill connection can throw synchronously.
        mockPool(log, command, {
          kill: () => {
            throw new Error("SSH tunnel unavailable")
          }
        })

        yield* withMockClient(Effect.scoped(Effect.gen(function*() {
          const sql = yield* MysqlClient.MysqlClient
          const conn = yield* sql.reserve
          const consumer = yield* conn.executeStream("SELECT 1 AS value", [], undefined).pipe(
            Stream.runDrain,
            Effect.forkChild
          )
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(consumer)
          // The connection may be retired instead of reused, so the statement
          // only has to settle rather than succeed.
          yield* conn.execute("SELECT 2 AS value", [], undefined).pipe(
            Effect.exit,
            Effect.timeout("2 seconds")
          )
        })))
        assert.isTrue(
          log.includes("start SELECT 2 AS value") || log.includes("connection destroyed"),
          log.join(", ")
        )
      }), { timeout: 60_000 })
  })
})

/**
 * Provides a mysql2 pool whose only connection, thread 7, runs streams through
 * `command` and every other statement in 50 ms. Unless `kill` provides the
 * connection for it, a `KILL QUERY` reaches the server 20 ms after it is sent,
 * and then calls `onKill`.
 */
const mockPool = (
  log: Array<string>,
  command: EventEmitter,
  options: { readonly onKill?: () => void; readonly kill?: () => Mysql.Connection } = {}
) => {
  const onKill = options.onKill ?? (() => {})
  const conn = {
    threadId: 7,
    query: (options: string | { sql: string }, ...args: Array<any>) => {
      if (typeof options === "string") return command
      args[args.length - 1](null, [])
    },
    execute: (options: { sql: string }, callback: (cause: null, rows: Array<unknown>) => void) => {
      log.push(`start ${options.sql}`)
      setTimeout(() => {
        log.push(`end ${options.sql}`)
        callback(null, [{ value: 2 }])
      }, 50)
    },
    release: () => {},
    destroy: () => {
      log.push("connection destroyed")
    }
  }
  vi.mocked(Mysql.createPool).mockReturnValueOnce({
    query: (_sql: string, callback: (cause: null) => void) => callback(null),
    getConnection: (callback: (cause: null, conn: unknown) => void) => callback(null, conn),
    end: (callback: () => void) => callback()
  } as unknown as Mysql.Pool)
  vi.mocked(Mysql.createConnection).mockImplementationOnce(
    options.kill ?? (() =>
      ({
        on: () => {},
        destroy: () => {},
        query: (_sql: string, values: Array<unknown>, callback: () => void) => {
          setTimeout(() => {
            log.push(`kill ${values[0]}`)
            onKill()
            callback()
          }, 20)
        }
      }) as unknown as Mysql.Connection)
  )
}

const withMockClient = <A, E>(effect: Effect.Effect<A, E, MysqlClient.MysqlClient>) =>
  effect.pipe(
    Effect.provide(MysqlClient.layer({})),
    Effect.ensuring(Effect.sync(() => vi.mocked(Mysql.createConnection).mockReset()))
  )

const cancelSettlingStream = Effect.fnUntraced(function*(maxOpsBeforeYield: number) {
  const log: Array<string> = []
  const command = Object.assign(new EventEmitter(), {
    stream: () => {
      const rows = new Readable({ objectMode: true, read() {} })
      rows.push({ value: 1 })
      rows._destroy = (error, callback) => {
        // The statement ends right after the stream is destroyed, before
        // the fiber resumes.
        queueMicrotask(() => {
          log.push("stream end")
          command.emit("end")
        })
        callback(error)
      }
      return rows
    }
  })
  mockPool(log, command)

  yield* withMockClient(Effect.gen(function*() {
    const sql = yield* MysqlClient.MysqlClient
    yield* sql.withTransaction(Effect.gen(function*() {
      let queued: Fiber.Fiber<unknown, unknown> | undefined
      yield* sql`SELECT 1 AS value`.stream.pipe(
        // Queue a statement on the same connection while the stream runs.
        Stream.tap(() =>
          Effect.map(Effect.forkChild(sql`SELECT 2 AS value`, { startImmediately: true }), (fiber) => {
            queued = fiber
          })
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOpsBeforeYield)
      )
      yield* Fiber.join(queued!)
    }))
  }))
  return log
})

const interruptStreamSetup = Effect.fnUntraced(function*(maxOpsBeforeYield: number) {
  const log: Array<string> = []
  let consumer: Fiber.Fiber<unknown, unknown> | undefined
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    log.push("stream end")
    command.emit("end")
  }
  const command = Object.assign(new EventEmitter(), {
    stream: () => {
      // As soon as the statement has started, interrupt the consumer, which
      // closes the stream, and the stream's setup, which closing the stream
      // would otherwise only reach after the setup resumes. Unless it is
      // killed, the statement ends on its own after 100 ms.
      const setup = Fiber.getCurrent()!
      queueMicrotask(() => {
        setup.interruptUnsafe()
        consumer!.interruptUnsafe()
      })
      setTimeout(end, 100)
      return new Readable({ objectMode: true, read() {} })
    }
  })
  mockPool(log, command, { onKill: end })

  yield* withMockClient(Effect.gen(function*() {
    const sql = yield* MysqlClient.MysqlClient
    yield* sql.withTransaction(Effect.gen(function*() {
      consumer = yield* sql`SELECT 1 AS value`.stream.pipe(
        Stream.runDrain,
        Effect.provideService(Scheduler.MaxOpsBeforeYield, maxOpsBeforeYield),
        Effect.forkChild
      )
      yield* Fiber.await(consumer)
      yield* sql`SELECT 2 AS value`
    }))
  }))
  return log
})

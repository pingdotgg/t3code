import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Option, Scope } from "effect"
import { SqlClient, SqlError } from "effect/unstable/sql"

interface StubConnection {
  readonly id: string
}

interface StubTransactionConnection {
  readonly _: unique symbol
}

const sqlError = (message: string) =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({ cause: new Error(message), message })
  })

let harnessIdCounter = 0

/**
 * Builds a `makeWithTransaction` wrapper over stub transaction commands, so the
 * transaction control flow can be driven without a database driver.
 *
 * The stubs mirror the driver contract: `rollback` and `rollbackSavepoint` fail
 * when no transaction or savepoint is active, which is what a real database
 * reports when a rollback is issued after a failed `BEGIN`.
 */
const makeHarness = (failures: {
  readonly begin?: SqlError.SqlError | undefined
  readonly savepoint?: SqlError.SqlError | undefined
} = {}) => {
  const calls: Array<string> = []
  const conn: StubConnection = { id: "stub" }
  const transactionService = Context.Service<
    StubTransactionConnection,
    readonly [conn: StubConnection, counter: number]
  >(`test/SqlClient/TransactionConnection/${harnessIdCounter++}`)

  let transactionActive = false
  const savepoints: Array<number> = []

  const record = (name: string) => Effect.sync(() => calls.push(name))

  const withTransaction = SqlClient.makeWithTransaction({
    transactionService,
    spanAttributes: [],
    acquireConnection: Effect.flatMap(Scope.make(), (scope) =>
      Effect.as(
        Effect.flatMap(
          record("acquireConnection"),
          () => Scope.addFinalizer(scope, record("closeConnection"))
        ),
        [scope, conn] as const
      )),
    begin: () =>
      Effect.flatMap(record("begin"), () => {
        if (failures.begin !== undefined) {
          return Effect.fail(failures.begin)
        }
        transactionActive = true
        return Effect.void
      }),
    savepoint: (_conn, id) =>
      Effect.flatMap(record(`savepoint(${id})`), () => {
        if (failures.savepoint !== undefined) {
          return Effect.fail(failures.savepoint)
        }
        savepoints.push(id)
        return Effect.void
      }),
    commit: () =>
      Effect.flatMap(record("commit"), () =>
        transactionActive
          ? Effect.sync(() => {
            transactionActive = false
          })
          : Effect.fail(sqlError("cannot commit - no transaction is active"))),
    rollback: () =>
      Effect.flatMap(record("rollback"), () =>
        transactionActive
          ? Effect.sync(() => {
            transactionActive = false
          })
          : Effect.fail(sqlError("cannot rollback - no transaction is active"))),
    rollbackSavepoint: (_conn, id) =>
      Effect.flatMap(record(`rollbackSavepoint(${id})`), () =>
        savepoints.includes(id)
          ? Effect.sync(() => {
            savepoints.splice(savepoints.indexOf(id), 1)
          })
          : Effect.fail(sqlError(`cannot rollback to savepoint ${id} - it does not exist`)))
  })

  return { calls, withTransaction } as const
}

const assertTypedFailure = <A, E>(exit: Exit.Exit<A, E>, error: E) => {
  assert.isTrue(Exit.isFailure(exit))
  if (!Exit.isFailure(exit)) {
    return
  }
  assert.isFalse(
    Cause.hasDies(exit.cause),
    `expected a typed failure but the cause contains a defect:\n${Cause.pretty(exit.cause)}`
  )
  assert.deepStrictEqual(Cause.findErrorOption(exit.cause), Option.some(error))
}

describe("SqlClient", () => {
  describe("makeWithTransaction", () => {
    it.effect("propagates a failed begin as a typed error without rolling back", () =>
      Effect.gen(function*() {
        const beginError = sqlError("database is locked")
        const harness = makeHarness({ begin: beginError })
        let executed = false

        const exit = yield* Effect.exit(harness.withTransaction(Effect.sync(() => {
          executed = true
        })))

        assertTypedFailure(exit, beginError)
        assert.isFalse(executed)
        assert.deepStrictEqual(harness.calls, ["acquireConnection", "begin", "closeConnection"])
      }))

    it.effect("rolls back when the wrapped effect fails after a successful begin", () =>
      Effect.gen(function*() {
        const harness = makeHarness()

        const exit = yield* Effect.exit(harness.withTransaction(Effect.fail("boom" as const)))

        assertTypedFailure(exit, "boom" as const)
        assert.deepStrictEqual(harness.calls, ["acquireConnection", "begin", "rollback", "closeConnection"])
      }))

    it.effect("propagates a failed savepoint as a typed error without rolling back", () =>
      Effect.gen(function*() {
        const savepointError = sqlError("cannot create savepoint")
        const harness = makeHarness({ savepoint: savepointError })
        let executed = false

        const exit = yield* Effect.exit(harness.withTransaction(
          harness.withTransaction(Effect.sync(() => {
            executed = true
          }))
        ))

        assertTypedFailure(exit, savepointError)
        assert.isFalse(executed)
        assert.deepStrictEqual(harness.calls, [
          "acquireConnection",
          "begin",
          "savepoint(1)",
          "rollback",
          "closeConnection"
        ])
      }))

    it.effect("closes the connection scope when begin fails", () =>
      Effect.gen(function*() {
        const harness = makeHarness({ begin: sqlError("database is locked") })

        yield* Effect.exit(harness.withTransaction(Effect.void))

        assert.include(harness.calls, "closeConnection")
      }))

    it.effect("commits and returns the value when the wrapped effect succeeds", () =>
      Effect.gen(function*() {
        const harness = makeHarness()

        const result = yield* harness.withTransaction(Effect.succeed(1))

        assert.strictEqual(result, 1)
        assert.deepStrictEqual(harness.calls, ["acquireConnection", "begin", "commit", "closeConnection"])
      }))
  })
})

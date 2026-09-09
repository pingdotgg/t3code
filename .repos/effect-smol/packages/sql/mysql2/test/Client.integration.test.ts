import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import { SqlClient, Statement } from "effect/unstable/sql"
import { MysqlContainer } from "./utils.ts"

const SqlLogger = Layer.succeed(Statement.CurrentTransformer)((statement) => {
  const [query, params] = statement.compile()
  return Effect.log("executing sql").pipe(
    Effect.annotateLogs({ query, params }),
    Effect.as(statement)
  )
})

describe("sql", () => {
  it.effect("tranformers", () =>
    Effect.gen(function*() {
      const logs: Array<unknown> = []
      const sql = yield* SqlClient.SqlClient
      const result = yield* sql<{ result: number }>`SELECT 1 + 1 AS result`.pipe(
        Effect.provide(Logger.layer([
          Logger.make((log) => {
            logs.push(log.message)
          })
        ]))
      )
      assert.deepStrictEqual(result, [{ result: 2 }])
      assert.deepStrictEqual(logs, [["executing sql"]])
    }).pipe(
      Effect.provide(MysqlContainer.layerClient.pipe(
        Layer.provideMerge(SqlLogger)
      )),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })
})

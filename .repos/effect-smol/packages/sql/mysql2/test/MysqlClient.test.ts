import { MysqlClient } from "@effect/sql-mysql2"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"

import { MysqlContainer } from "./utils.ts"

describe("MysqlClient", () => {
  it.effect("stream returns same rows as direct execution", () =>
    Effect.gen(function*() {
      const sql = yield* MysqlClient.MysqlClient

      yield* sql`DROP TABLE IF EXISTS stream_regression_test`
      yield* sql`CREATE TABLE stream_regression_test (id INT PRIMARY KEY AUTO_INCREMENT, value VARCHAR(255))`

      const testData = Array.from({ length: 100 }, (_, i) => ({ value: `row_${i}` }))
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
})

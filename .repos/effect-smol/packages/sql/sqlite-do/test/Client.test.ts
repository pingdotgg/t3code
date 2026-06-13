import { SqliteClient } from "@effect/sql-sqlite-do"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"

describe("Client", () => {
  it.effect("classifies native errors without stable sqlite codes as UnknownError", () =>
    Effect.gen(function*() {
      const failingDb = {
        exec: () => {
          throw new Error("boom")
        }
      } as any

      const client = yield* SqliteClient.make({ db: failingDb })
      const error = yield* Effect.flip(client`SELECT 1`)
      assert.strictEqual(error.reason._tag, "UnknownError")
    }).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer)
    ))

  it.effect("should work", () => Effect.void)
})

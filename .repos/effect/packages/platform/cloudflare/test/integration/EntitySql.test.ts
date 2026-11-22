import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | Entity DurableObjectSqlClient", () => {
  it.effect(
    "keeps committed handler rows in the entity's Durable Object across an isolate restart",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const appended = yield* cluster.fetchJson("/journal/append?id=one&entries=a,b")
        assert.deepStrictEqual(appended, { _tag: "Success", value: 2 })
        assert.deepStrictEqual(yield* cluster.fetchJson("/journal/list?id=one"), { entries: ["a", "b"] })
        assert.deepStrictEqual(
          yield* cluster.fetchJson("/journal/list?id=two"),
          { entries: [] },
          "Rows leaked into another entity's Durable Object"
        )

        yield* cluster.restart

        assert.deepStrictEqual(
          yield* cluster.fetchJson("/journal/list?id=one"),
          { entries: ["a", "b"] },
          "Handler rows did not survive the isolate restart"
        )
      }),
    60_000
  )

  it.effect("rolls back every row of a failed handler transaction", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const failed = yield* cluster.fetchJson("/journal/append?id=rollback&entries=a,b&fail=true")
      assert.strictEqual(failed._tag, "Failure")
      assert.include(failed.cause, "rejected")
      assert.deepStrictEqual(
        yield* cluster.fetchJson("/journal/list?id=rollback"),
        { entries: [] },
        "A failed transaction left partial rows behind"
      )

      const appended = yield* cluster.fetchJson("/journal/append?id=rollback&entries=c,d")
      assert.deepStrictEqual(appended, { _tag: "Success", value: 2 })
      assert.deepStrictEqual(yield* cluster.fetchJson("/journal/list?id=rollback"), { entries: ["c", "d"] })
    }), 60_000)

  it.effect("keeps another handler's stored reply out of a rolled-back transaction", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const result = yield* cluster.fetchJson("/coordinated/release?id=gate")
      assert.strictEqual(result.released._tag, "Failure")
      assert.include(result.released.cause, "rejected")
      assert.strictEqual(result.waited, "released")
      assert.deepStrictEqual(
        result.rows.map((row: { readonly message_id: string; readonly processed: number }) => [
          row.message_id,
          row.processed
        ]),
        [["Coordinated/gate/Wait/wait", 1]],
        "The Wait reply was rolled back with the other handler's transaction"
      )
    }), 60_000)
})

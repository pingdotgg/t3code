import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | Cancellation", () => {
  it.effect(
    "interrupts the entity handler and releases its permit when the caller is interrupted",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster
        const result = yield* cluster.fetchJson("/serial/cancel?id=one")

        assert.strictEqual(result.interrupted, 1, "The client interrupt did not reach the in-flight entity handler")
        assert.strictEqual(result.completed, 0, "The interrupted handler still ran to completion")
        assert.strictEqual(
          result.quick,
          "ok",
          "The entity leaked its concurrency permit after the handler was interrupted"
        )
      }),
    60_000
  )

  it.effect("runs an Uninterruptible handler to completion despite a client interrupt", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster
      const result = yield* cluster.fetchJson("/serial/uninterruptible?id=one")

      assert.strictEqual(
        result.completed,
        1,
        "The Uninterruptible handler was interrupted instead of running to completion"
      )
      assert.strictEqual(
        result.quick,
        "ok",
        "The entity leaked its concurrency permit after the Uninterruptible handler finished"
      )
    }), 60_000)
})

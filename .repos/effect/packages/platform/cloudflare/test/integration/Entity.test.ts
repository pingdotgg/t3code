import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | Entity", () => {
  it.effect(
    "asks and tells volatile and persisted RPCs through real Worker-to-DO bindings",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const persisted = yield* cluster.fetchJson("/counter/increment?id=basic&op=one")
        assert.strictEqual(persisted.value, 1, "The persisted ask did not run the entity handler")

        yield* cluster.fetchJson("/counter/increment?id=basic&op=two&discard=true")
        const volatile = yield* cluster.fetchJson("/counter/increment-volatile?id=basic")
        assert.strictEqual(volatile.value, 3, "The persisted tell or the volatile ask did not reach the entity")

        const read = yield* cluster.fetchJson("/counter/get?id=basic")
        assert.strictEqual(read.value, 3)
      }),
    60_000
  )

  it.effect("streams persisted chunks with acknowledgements to the client", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster
      const result = yield* cluster.fetchJson("/counter/watch?id=stream")
      assert.deepStrictEqual(result.values, [1, 2, 3], "The persisted stream did not deliver every chunk in order")
    }), 60_000)

  it.effect("propagates typed failures and defects through the reply protocol", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const failure = yield* cluster.fetchJson("/counter/fail?id=errors")
      assert.strictEqual(failure._tag, "Failure", "The typed failure was not surfaced to the caller")
      assert.include(failure.cause, "typed:errors")

      const defect = yield* cluster.fetchJson("/counter/defect?id=errors")
      assert.strictEqual(defect._tag, "Failure", "The defect was not surfaced to the caller")
      assert.include(defect.cause, "defect:errors")

      const read = yield* cluster.fetchJson("/counter/get?id=errors")
      assert.strictEqual(read.value, 0, "A failing RPC unexpectedly mutated entity state")
    }), 60_000)

  it.effect("asks another entity from inside a handler through the public client", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster
      yield* cluster.fetchJson("/counter/increment?id=relay-target&op=one")
      const result = yield* cluster.fetchJson("/relay/ask?id=relay&target=relay-target")
      assert.strictEqual(result.value, 1, "The entity-to-entity ask through Entity.client did not deliver a reply")
    }), 60_000)

  it.effect("builds handlers exactly once under concurrent first contact", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster
      const before = yield* cluster.fetchJson("/state")

      const result = yield* cluster.fetchJson("/counter/first-contact?id=cold&n=8")
      assert.deepStrictEqual(
        result.values,
        [1, 2, 3, 4, 5, 6, 7, 8],
        "Concurrent first contact lost or duplicated a request"
      )

      const after = yield* cluster.fetchJson("/state")
      assert.strictEqual(
        (after.builds.Counter ?? 0) - (before.builds.Counter ?? 0),
        1,
        "Concurrent first contact constructed the entity handlers more than once"
      )

      const followUp = yield* cluster.fetchJson("/counter/increment?id=cold&op=after")
      assert.strictEqual(followUp.value, 9, "The entity leaked a permit or waiter after concurrent first contact")
    }), 60_000)

  it.effect(
    "rejects a persisted request over the 2 MB row limit without wedging the mailbox",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const rejected = yield* cluster.fetchJson("/counter/big?id=limits&bytes=2500000")
        assert.strictEqual(rejected._tag, "Failure", "The oversized persisted request was not rejected")
        assert.include(rejected.cause, "2 MB", "The rejection did not identify the 2 MB persistence limit")

        const healthy = yield* cluster.fetchJson("/counter/increment?id=limits&op=after")
        assert.strictEqual(healthy.value, 1, "The mailbox stopped accepting requests after an oversized reject")
      }),
    60_000
  )
})

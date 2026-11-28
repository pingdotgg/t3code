import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | KeepAlive", () => {
  it.effect(
    "pins the entity Durable Object while keepAlive holders exist and unpins on release",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        yield* cluster.fetchJson("/pinned/pin?id=one")
        yield* cluster.waitUntil(
          "Entity.keepAlive(true) did not establish a hold on the entity Durable Object",
          Effect.map(cluster.fetchJson("/holds?type=Pinned&id=one"), (result) => result.holds === 1)
        )

        // A second holder does not stack a second hold on the object.
        yield* cluster.fetchJson("/pinned/pin?id=one")
        const stacked = yield* cluster.fetchJson("/holds?type=Pinned&id=one")
        assert.strictEqual(stacked.holds, 1, "A second keepAlive holder opened a duplicate hold on the Durable Object")

        yield* cluster.fetchJson("/pinned/unpin?id=one")
        const held = yield* cluster.fetchJson("/holds?type=Pinned&id=one")
        assert.strictEqual(held.holds, 1, "Releasing one of two keepAlive holders dropped the hold early")

        yield* cluster.fetchJson("/pinned/unpin?id=one")
        yield* cluster.waitUntil(
          "Releasing the last keepAlive holder did not unpin the entity Durable Object",
          Effect.map(cluster.fetchJson("/holds?type=Pinned&id=one"), (result) => result.holds === 0)
        )
      }),
    60_000
  )

  it.effect("releases an EntityResource hold after its idle time to live", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const value = yield* cluster.fetchJson("/holder/get?id=ttl")
      assert.strictEqual(value.value, 1, "The EntityResource was not acquired on first use")
      yield* cluster.waitUntil(
        "Acquiring the EntityResource did not pin the entity Durable Object",
        Effect.map(cluster.fetchJson("/holds?type=Holder&id=ttl"), (result) => result.holds === 1)
      )

      yield* cluster.waitUntil(
        "The EntityResource was not released after its idle time to live",
        Effect.map(cluster.fetchJson("/state"), (state) => state.resource.released === 1)
      )
      yield* cluster.waitUntil(
        "The idle EntityResource release did not unpin the entity Durable Object",
        Effect.map(cluster.fetchJson("/holds?type=Holder&id=ttl"), (result) => result.holds === 0)
      )

      // The next use re-acquires the resource.
      const again = yield* cluster.fetchJson("/holder/get?id=ttl")
      assert.strictEqual(again.value, 2, "The EntityResource was not re-acquired after the idle release")
    }), 60_000)

  it.effect("releases an EntityResource hold on explicit close", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      yield* cluster.fetchJson("/holder/get?id=close")
      yield* cluster.waitUntil(
        "Acquiring the EntityResource did not pin the entity Durable Object",
        Effect.map(cluster.fetchJson("/holds?type=Holder&id=close"), (result) => result.holds === 1)
      )

      yield* cluster.fetchJson("/holder/close?id=close")
      yield* cluster.waitUntil(
        "Closing the EntityResource did not release its hold on the Durable Object",
        Effect.map(
          Effect.all([cluster.fetchJson("/state"), cluster.fetchJson("/holds?type=Holder&id=close")]),
          ([state, holds]) => state.resource.released >= 1 && holds.holds === 0
        )
      )
    }), 60_000)
})

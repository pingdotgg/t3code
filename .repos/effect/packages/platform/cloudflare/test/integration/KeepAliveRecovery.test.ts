import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

// After a restart nothing in these tests messages the entity before the
// rebuild is observed: the entity Durable Object has to wake on its own.
describe("Cloudflare cluster integration | KeepAlive recovery", () => {
  it.live("rebuilds an entity holding keepAlive after an isolate restart", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      yield* cluster.fetchJson("/pinned/pin?id=recover")
      yield* cluster.waitUntil(
        "Entity.keepAlive(true) did not establish a hold on the entity Durable Object",
        Effect.map(cluster.fetchJson("/holds?type=Pinned&id=recover"), (result) => result.holds === 1)
      )

      yield* cluster.restart

      yield* cluster.waitUntil(
        "The keep-alive entity was not rebuilt after the isolate restart",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.builds["Pinned/recover"] ?? 0) === 1)
      )
      yield* cluster.waitUntil(
        "The rebuilt keep-alive entity did not hold its Durable Object again",
        Effect.map(cluster.fetchJson("/holds?type=Pinned&id=recover"), (result) => result.holds === 1)
      )

      // Releasing keep-alive ends the recovery: the next restart leaves the
      // entity cold.
      yield* cluster.fetchJson("/pinned/unpin?id=recover")
      yield* cluster.waitUntil(
        "Releasing keepAlive did not unpin the entity Durable Object",
        Effect.map(cluster.fetchJson("/holds?type=Pinned&id=recover"), (result) => result.holds === 0)
      )
      yield* cluster.restart
      yield* Effect.sleep("2 seconds")
      const state = yield* cluster.fetchJson("/state")
      assert.isUndefined(
        state.builds["Pinned/recover"],
        "The entity was rebuilt after a restart although it had released keepAlive"
      )
    }), 60_000)
})

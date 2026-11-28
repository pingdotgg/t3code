import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | Persistence", () => {
  it.effect("completes a persisted tell caller while the handler is still running", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      // The gate stays closed, so a caller pinned to the handler would hang.
      yield* cluster.fetchJson("/blocker/hold?id=pin&op=first")
      yield* cluster.waitUntil(
        "The persisted tell did not start its handler",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.entered["pin/first"] ?? 0) === 1)
      )
      const state = yield* cluster.fetchJson("/state")
      assert.isUndefined(state.completed["pin/first"], "The gated handler completed unexpectedly")

      yield* cluster.fetchJson("/blocker/open?id=pin&op=first")
      yield* cluster.waitUntil(
        "The persisted tell handler did not complete after its gate opened",
        Effect.map(cluster.fetchJson("/state"), (current) => (current.completed["pin/first"] ?? 0) === 1)
      )
    }), 60_000)

  it.effect("replays an interrupted persisted request after an isolate restart", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      // Persist a tell whose handler blocks on a gate that never opens in
      // this isolate: the request is journaled but never completes.
      yield* cluster.fetchJson("/blocker/hold?id=replay&op=first")
      yield* cluster.waitUntil(
        "The persisted Hold request did not start before the restart",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.entered["replay/first"] ?? 0) === 1)
      )

      // The restart wipes isolate memory mid-handler; the mailbox row stays
      // unprocessed in Durable Object SQLite.
      yield* cluster.restart

      // First contact wakes the entity and replays the unprocessed row.
      const before = yield* cluster.fetchJson("/blocker/get?id=replay")
      assert.strictEqual(before.value, 0, "The interrupted execution completed before the restart")
      yield* cluster.waitUntil(
        "The persisted Hold request was not replayed after the isolate restart",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.entered["replay/first"] ?? 0) === 1)
      )
      yield* cluster.fetchJson("/blocker/open?id=replay&op=first")
      yield* cluster.waitUntil(
        "The replayed Hold request did not run to completion",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.completed["replay/first"] ?? 0) === 1)
      )
      const after = yield* cluster.fetchJson("/blocker/get?id=replay")
      assert.strictEqual(after.value, 1, "The replayed request did not update entity state exactly once")
    }), 60_000)

  it.effect(
    "serves a primary-key duplicate from the stored reply across an isolate restart",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const first = yield* cluster.fetchJson("/counter/increment?id=stored&op=same")
        assert.strictEqual(first.value, 1)

        yield* cluster.restart

        const duplicate = yield* cluster.fetchJson("/counter/increment?id=stored&op=same")
        assert.strictEqual(
          duplicate.value,
          1,
          "The duplicate was not served from the reply stored in Durable Object SQLite"
        )
        const read = yield* cluster.fetchJson("/counter/get?id=stored")
        assert.strictEqual(read.value, 0, "The deduplicated request re-ran the handler after the restart")
      }),
    60_000
  )

  it.effect(
    "retries a defecting handler per policy, then stores a terminal defect and rebuilds handlers",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const exploded = yield* cluster.fetchJson("/flaky/boom?id=terminal&op=one")
        assert.strictEqual(exploded._tag, "Failure", "The exhausted defect retry did not surface a terminal defect")
        assert.include(exploded.cause, "boom:terminal")

        const state = yield* cluster.fetchJson("/state")
        assert.strictEqual(
          state.attempts["terminal/one"],
          3,
          "The defectRetryPolicy of Schedule.recurs(2) did not run the handler exactly three times"
        )
        assert.isAtLeast(
          state.builds.Flaky,
          2,
          "The entity handlers were not rebuilt in-wake after the terminal defect"
        )

        const duplicate = yield* cluster.fetchJson("/flaky/boom?id=terminal&op=one")
        assert.strictEqual(duplicate._tag, "Failure")
        const replayed = yield* cluster.fetchJson("/state")
        assert.strictEqual(
          replayed.attempts["terminal/one"],
          3,
          "The stored terminal defect was not served for the duplicate primary key"
        )

        const healthy = yield* cluster.fetchJson("/flaky/ping?id=terminal")
        assert.strictEqual(healthy.value, "pong", "The entity did not serve new requests after the terminal defect")
      }),
    60_000
  )

  it.effect("keeps volatile requests out of the journal", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      yield* cluster.fetchJson("/counter/increment-volatile?id=journal")
      yield* cluster.fetchJson("/counter/increment?id=journal&op=one")
      const rows = yield* cluster.fetchJson("/counter/rows?id=journal")
      assert.strictEqual(
        rows.rows.length,
        1,
        "Volatile requests were journaled alongside the persisted request"
      )

      yield* cluster.restart

      // Only the persisted increment survives; the volatile one was RAM-only.
      const read = yield* cluster.fetchJson("/counter/get?id=journal")
      assert.strictEqual(read.value, 0, "In-memory state unexpectedly survived the isolate restart")
      const replayed = yield* cluster.fetchJson("/counter/rows?id=journal")
      assert.strictEqual(replayed.rows.length, 1, "The journal was not preserved across the isolate restart")
      assert.strictEqual(replayed.rows[0].processed, 1, "The persisted request lost its processed marker")
    }), 60_000)
})

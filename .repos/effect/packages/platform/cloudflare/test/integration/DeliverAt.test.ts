import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | DeliverAt", () => {
  it.effect(
    "persists a delayed tell, arms the alarm, and delivers only after the deadline",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        // The offset must comfortably cover the two observation roundtrips
        // below, so the pre-deadline assertions cannot race the alarm.
        const scheduled = yield* cluster.fetchJson("/counter/scheduled?id=delayed&op=one&offset=2000&discard=true")

        const pending = yield* cluster.fetchJson("/counter/rows?id=delayed")
        assert.strictEqual(pending.rows.length, 1, "The delayed tell was not persisted in the destination mailbox")
        assert.strictEqual(pending.rows[0].processed, 0, "The delayed tell ran before its DeliverAt deadline")
        assert.strictEqual(pending.rows[0].deliver_at, scheduled.deliverAt)
        assert.strictEqual(
          pending.alarm,
          scheduled.deliverAt,
          "The destination alarm was not armed at the DeliverAt deadline"
        )

        yield* cluster.waitUntil(
          "The destination alarm did not run the delayed tell",
          Effect.map(cluster.fetchJson("/state"), (state) => (state.deliveries.delayed?.length ?? 0) === 1)
        )
        const state = yield* cluster.fetchJson("/state")
        const delivery = state.deliveries.delayed[0]
        assert.isAtLeast(
          delivery.deliveredAt,
          delivery.deliverAt,
          "The alarm delivered the scheduled request before its deadline"
        )

        const done = yield* cluster.fetchJson("/counter/rows?id=delayed")
        assert.strictEqual(done.rows[0].processed, 1, "The delivered row was not marked processed")
        assert.isNull(done.alarm, "The alarm stayed armed with no scheduled rows left")
      }),
    60_000
  )

  it.effect("wakes a cold isolate through the persisted alarm after a restart", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      // The offset must comfortably exceed the restart duration, so the
      // alarm cannot fire in the old isolate before it is torn down.
      yield* cluster.fetchJson("/counter/scheduled?id=cold-alarm&op=one&offset=3000&discard=true")
      yield* cluster.restart

      // No fetch touches the entity after the restart: only the Durable
      // Object alarm can deliver the row, through a fresh isolate whose
      // handlers register at Worker init.
      yield* cluster.waitUntil(
        "The persisted alarm did not wake the entity after the isolate restart",
        Effect.map(cluster.fetchJson("/state"), (state) => (state.deliveries["cold-alarm"]?.length ?? 0) === 1)
      )
      const read = yield* cluster.fetchJson("/counter/get?id=cold-alarm")
      assert.strictEqual(read.value, 1, "The alarm-delivered request did not run the entity handler")
    }), 60_000)

  it.effect("keeps a Worker delayed ask open and deduplicates concurrent primary keys", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const [first, second] = yield* Effect.all([
        cluster.fetchJson("/counter/scheduled?id=ask&op=same&offset=400"),
        cluster.fetchJson("/counter/scheduled?id=ask&op=same&offset=400")
      ], { concurrency: "unbounded" })

      assert.strictEqual(first.value, 1, "The delayed ask did not resolve with the handler result")
      assert.strictEqual(second.value, 1, "The deduplicated delayed ask did not share the stored reply")

      const read = yield* cluster.fetchJson("/counter/get?id=ask")
      assert.strictEqual(read.value, 1, "The deduplicated delayed ask ran the handler twice")
    }), 60_000)

  it.effect("delivers a delayed ask reply back to the calling entity", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const result = yield* cluster.fetchJson("/relay/scheduled?id=caller&target=relay-delayed")
      assert.strictEqual(result.value, 1, "The delayed reply did not reach the calling entity")
      const state = yield* cluster.fetchJson("/state")
      const delivery = state.deliveries["relay-delayed"][0]
      assert.isAtLeast(delivery.deliveredAt, delivery.deliverAt, "The delayed ask ran before its deadline")
    }), 60_000)
})

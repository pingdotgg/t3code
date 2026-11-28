import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { makeClusterWithHeartbeat } from "./harness.ts"

describe("Cloudflare cluster integration | In-flight heartbeat", () => {
  for (const discard of [true, false]) {
    it.effect(
      "keeps recovery armed until the last overlapping persisted " + (discard ? "tell" : "ask") + " completes",
      () =>
        Effect.gen(function*() {
          // Leave enough time to observe cleanup before an alarm wake could
          // hide a stale heartbeat by cleaning it up itself.
          const cluster = yield* makeClusterWithHeartbeat("30 seconds")
          const id = discard ? "overlapping-tells" : "overlapping-asks"
          const first = yield* Effect.forkChild(cluster.fetchJson(
            "/blocker/hold?id=" + id + "&op=first&discard=" + discard
          ))
          const second = yield* Effect.forkChild(cluster.fetchJson(
            "/blocker/hold?id=" + id + "&op=second&discard=" + discard
          ))
          yield* cluster.waitUntil(
            "Both persisted handlers did not start",
            Effect.map(cluster.fetchJson("/state"), (state) =>
              state.entered[id + "/first"] === 1 && state.entered[id + "/second"] === 1)
          )
          const running = yield* cluster.fetchJson("/blocker/rows?id=" + id)
          assert.isNotNull(running.alarm, "In-flight persisted requests had no recovery alarm")

          yield* cluster.fetchJson("/blocker/open?id=" + id + "&op=first")
          yield* Fiber.join(first)
          yield* cluster.waitUntil(
            "The first persisted request was not marked processed",
            Effect.map(cluster.fetchJson("/blocker/rows?id=" + id), (result) =>
              result.rows.filter((row: { processed: number }) =>
                row.processed === 1
              ).length === 1)
          )
          const overlapping = yield* cluster.fetchJson("/blocker/rows?id=" + id)
          assert.isNotNull(overlapping.alarm, "Completing one request dropped the other request's recovery alarm")

          yield* cluster.fetchJson("/blocker/open?id=" + id + "&op=second")
          yield* Fiber.join(second)
          yield* cluster.waitUntil(
            "The last persisted request was not marked processed",
            Effect.map(cluster.fetchJson("/blocker/rows?id=" + id), (result) =>
              result.rows.every((row: { processed: number }) =>
                row.processed === 1
              ))
          )
          const idle = yield* cluster.fetchJson("/blocker/rows?id=" + id)
          assert.isNull(idle.alarm, "The last completed persisted request left a wasted heartbeat wake")
        }),
      60_000
    )
  }

  it.effect(
    "replaces the last in-flight heartbeat with the remaining scheduled delivery",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeClusterWithHeartbeat("5 seconds")
        yield* cluster.fetchJson("/blocker/hold?id=scheduled-heartbeat&op=hold")
        yield* cluster.waitUntil(
          "The persisted handler did not start",
          Effect.map(cluster.fetchJson("/state"), (state) => state.entered["scheduled-heartbeat/hold"] === 1)
        )
        const running = yield* cluster.fetchJson("/blocker/rows?id=scheduled-heartbeat")
        const scheduled = yield* cluster.fetchJson("/blocker/scheduled?id=scheduled-heartbeat&offset=8000")
        assert.isBelow(running.alarm, scheduled.deliverAt, "The heartbeat must precede the scheduled delivery")

        yield* cluster.fetchJson("/blocker/open?id=scheduled-heartbeat&op=hold")
        yield* cluster.waitUntil(
          "The persisted tell was not marked processed",
          Effect.map(cluster.fetchJson("/blocker/rows?id=scheduled-heartbeat"), (result) =>
            result.rows.some((row: { processed: number; deliver_at: number | null }) =>
              row.deliver_at === null && row.processed === 1
            ))
        )
        const remaining = yield* cluster.fetchJson("/blocker/rows?id=scheduled-heartbeat")

        yield* cluster.restart
        yield* cluster.waitUntil(
          "Cleanup dropped the scheduled delivery alarm",
          Effect.map(cluster.fetchJson("/state"), (state) =>
            state.deliveries["scheduled-heartbeat"]?.length === 1)
        )
        const state = yield* cluster.fetchJson("/state")
        assert.isAtLeast(state.deliveries["scheduled-heartbeat"][0].deliveredAt, scheduled.deliverAt)
        assert.strictEqual(remaining.alarm, scheduled.deliverAt, "Cleanup did not leave only the scheduled alarm")
      }),
    60_000
  )

  it.effect("preserves keep-alive recovery when the last persisted request completes", () =>
    Effect.gen(function*() {
      const cluster = yield* makeClusterWithHeartbeat("1 second")
      yield* cluster.fetchJson("/blocker/pin?id=kept-heartbeat")
      yield* cluster.fetchJson("/blocker/hold?id=kept-heartbeat&op=hold")
      yield* cluster.waitUntil(
        "The persisted handler did not start",
        Effect.map(cluster.fetchJson("/state"), (state) => state.entered["kept-heartbeat/hold"] === 1)
      )
      yield* cluster.fetchJson("/blocker/open?id=kept-heartbeat&op=hold")
      yield* cluster.waitUntil(
        "The persisted tell was not marked processed",
        Effect.map(cluster.fetchJson("/blocker/rows?id=kept-heartbeat"), (result) =>
          result.rows.length === 1 && result.rows[0].processed === 1)
      )
      const kept = yield* cluster.fetchJson("/blocker/rows?id=kept-heartbeat")
      assert.isNotNull(kept.alarm, "Completing the last request dropped the keep-alive alarm")

      yield* cluster.restart
      // Observe only Worker state after restart, never contact the entity.
      yield* cluster.waitUntil(
        "Cleanup broke keep-alive recovery after restart",
        Effect.map(cluster.fetchJson("/state"), (state) =>
          state.builds.Blocker === 1)
      )
      yield* cluster.waitUntil(
        "The rebuilt entity did not restore its keep-alive hold",
        Effect.map(cluster.fetchJson("/holds?type=Blocker&id=kept-heartbeat"), (result) => result.holds === 1)
      )
      yield* cluster.fetchJson("/blocker/unpin?id=kept-heartbeat")
    }), 60_000)
})

import { assert, describe, it } from "@effect/vitest"
import { Cron, Effect } from "effect"
import { makeCluster } from "./harness.ts"

describe("Cloudflare cluster integration | Singleton and ClusterCron", () => {
  it.effect("runs the singleton once per wake, coalescing concurrent wakes", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      // Two wakes while the singleton run is blocked coalesce into one run.
      yield* cluster.fetchJson("/singleton/wake")
      yield* cluster.waitUntil(
        "The singleton wake did not start the registered effect",
        Effect.map(cluster.fetchJson("/state"), (state) => state.singleton.starts === 1)
      )
      yield* cluster.fetchJson("/singleton/wake")
      const blocked = yield* cluster.fetchJson("/state")
      assert.strictEqual(blocked.singleton.starts, 1, "A concurrent wake started a second singleton run")

      yield* cluster.openGate("singleton")
      yield* cluster.waitUntil(
        "The singleton run did not complete after its gate opened",
        Effect.map(cluster.fetchJson("/state"), (state) => state.singleton.done === 1)
      )

      // After completion the next wake starts a fresh run.
      yield* cluster.fetchJson("/singleton/wake")
      yield* cluster.waitUntil(
        "A wake after completion did not start a new singleton run",
        Effect.map(cluster.fetchJson("/state"), (state) => state.singleton.done === 2)
      )
      const state = yield* cluster.fetchJson("/state")
      assert.strictEqual(state.singleton.maxActive, 1, "Two singleton runs were active at the same time")
    }), 60_000)

  it.effect(
    "seeds ClusterCron from a wake and fires per-instant ticks through destination alarms",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster
        const cron = Cron.parseUnsafe("* * * * * *", "UTC")

        yield* cluster.fetchJson("/cron/wake")
        yield* cluster.waitUntil(
          "The ClusterCron did not fire at least two ticks through the destination alarm",
          Effect.map(cluster.fetchJson("/state"), (state) => state.ticks.length >= 2),
          15_000
        )

        const state = yield* cluster.fetchJson("/state")
        const ticks: Array<{ at: number; scheduled: string }> = state.ticks
        const scheduled = ticks.map((tick) => tick.scheduled)
        assert.strictEqual(
          new Set(scheduled).size,
          scheduled.length,
          "The ClusterCron ran more than one tick for a single scheduled instant"
        )
        for (const tick of ticks) {
          if (tick.scheduled === "initial") continue
          const instant = Date.parse(tick.scheduled)
          assert.isTrue(
            Cron.match(cron, new Date(instant)),
            `The tick instant ${tick.scheduled} is not a valid cron occurrence`
          )
          assert.isAtLeast(
            tick.at,
            instant,
            `The tick for ${tick.scheduled} ran before its scheduled instant`
          )
        }
      }),
    60_000
  )
})

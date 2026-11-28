import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

const kinds = ["entity", "workflow", "queue", "singleton"] as const

describe("Cloudflare cluster integration | initialization readiness", () => {
  it.effect("holds every cold Durable Object path until registration completes", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster
      yield* cluster.fetchJson("/initialization/block")

      const calls = kinds.map((kind) =>
        Effect.runPromise(cluster.fetchJson(`/initialization/call?kind=${kind}`)).then(
          (result) => result,
          (error) => ({ ok: false, error: String(error) })
        )
      )

      yield* cluster.waitUntil(
        "The cold Durable Object calls did not reach the initialization barrier",
        Effect.map(
          cluster.fetchJson("/initialization/state"),
          (state) => state.started && state.callsStarted.length === kinds.length
        )
      )
      const blocked = yield* cluster.fetchJson("/initialization/state")
      assert.deepStrictEqual(
        blocked.callsCompleted,
        [],
        "A Durable Object call completed before application registration"
      )

      yield* cluster.fetchJson("/initialization/open")
      const results = yield* Effect.promise(() => Promise.all(calls))
      const initialized = yield* cluster.fetchJson("/initialization/state")
      assert.isTrue(initialized.completed, "The application initializer did not complete")
      assert.deepStrictEqual(
        results,
        kinds.map(() => ({ ok: true })),
        JSON.stringify(initialized)
      )
    }), 60_000)

  it.effect("holds a cold alarm on the same initialization barrier", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      yield* cluster.fetchJson("/counter/scheduled?id=readiness-alarm&op=one&offset=3000&discard=true")
      yield* cluster.restart
      yield* cluster.fetchJson("/initialization/block")

      yield* cluster.waitUntil(
        "The cold alarm did not start application initialization",
        Effect.map(cluster.fetchJson("/initialization/state"), (state) => state.started)
      )
      const blocked = yield* cluster.fetchJson("/initialization/state")
      assert.deepStrictEqual(
        blocked.callsStarted,
        [],
        "A Worker request, rather than the alarm, started initialization"
      )

      yield* cluster.fetchJson("/initialization/open")
      yield* cluster.waitUntil(
        "The alarm did not run after application registration completed",
        Effect.map(
          cluster.fetchJson("/state"),
          (state) => (state.deliveries["readiness-alarm"]?.length ?? 0) === 1
        )
      )
    }), 60_000)

  it.effect(
    "lets the next cold caller take over a stalled initialization and keeps its late success",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster
        yield* cluster.fetchJson("/initialization/block")

        const stalled = Effect.runPromise(cluster.fetchJson("/initialization/call?kind=entity")).catch(String)
        yield* cluster.waitUntil(
          "The first cold Durable Object did not start application initialization",
          Effect.map(cluster.fetchJson("/initialization/state"), (state) => state.started)
        )

        // Start a genuinely cold caller after the build is stale. Starting it
        // immediately leaves only the gap between the two callers in which a
        // 20ms poll can observe a stale build while the waiter is still fresh.
        yield* cluster.waitUntil(
          "The first initialization did not become stale",
          Effect.map(cluster.fetchJson("/initialization/state"), (state) => state.elapsedMillis >= 15_000),
          20_000
        )
        yield* cluster.fetchJson("/initialization/fail")
        const replacement = yield* cluster.fetchJson("/initialization/call?kind=workflow")
        assert.isFalse(replacement.ok)
        assert.include(
          replacement.error,
          "deliberate Cloudflare application initialization failure",
          "The next cold caller did not run the initializer itself after the first build stalled"
        )

        yield* cluster.fetchJson("/initialization/recover")
        yield* cluster.fetchJson("/initialization/open")
        const late = yield* Effect.promise(() => stalled)
        assert.deepStrictEqual(
          late,
          { ok: true },
          "The stalled build's late success was lost after the replacement failed"
        )
      }),
    60_000
  )

  it.effect(
    "reports an initialization failure to every cold caller and retries on the next cold call",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster
        yield* cluster.fetchJson("/initialization/fail")

        const results = yield* Effect.promise(() =>
          Promise.all(kinds.map((kind) => Effect.runPromise(cluster.fetchJson(`/initialization/call?kind=${kind}`))))
        )
        for (const result of results) {
          assert.isFalse(result.ok)
          assert.include(result.error, "deliberate Cloudflare application initialization failure")
        }

        yield* cluster.fetchJson("/initialization/recover")
        const retried = yield* cluster.fetchJson("/initialization/call?kind=entity")
        assert.deepStrictEqual(retried, { ok: true }, "A cold call after the failure reused the cached failure")
      }),
    60_000
  )
})

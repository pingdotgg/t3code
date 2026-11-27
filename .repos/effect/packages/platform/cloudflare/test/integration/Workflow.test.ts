import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCluster } from "./harness.ts"

const pollComplete = (cluster: { fetchJson: (path: string) => Effect.Effect<any> }, name: string, id: string) =>
  Effect.map(
    cluster.fetchJson(`/workflow/poll?name=${name}&id=${id}`),
    (result) => result._tag === "Complete" ? result : undefined
  )

describe("Cloudflare cluster integration | Workflow", () => {
  it.effect("executes a workflow end to end and deduplicates concurrent callers", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const [first, second] = yield* Effect.all([
        cluster.fetchJson("/workflow/execute?name=email&id=dedup&value=41"),
        cluster.fetchJson("/workflow/execute?name=email&id=dedup&value=41")
      ], { concurrency: "unbounded" })

      assert.strictEqual(first.result, 42, "The workflow did not run its activity end to end")
      assert.strictEqual(second.result, 42, "The concurrent duplicate execution did not share the same result")

      const state = yield* cluster.fetchJson("/state")
      assert.strictEqual(
        state.activityRuns.dedup,
        1,
        "Concurrent executions with one idempotency key ran the Send activity more than once"
      )
    }), 60_000)

  it.effect(
    "replays a completed activity without re-running it after an isolate restart",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        const done = yield* cluster.fetchJson("/workflow/execute?name=email&id=replay&value=1")
        assert.strictEqual(done.result, 2)

        yield* cluster.restart

        // Polling after the restart loads the execution from workflow Durable
        // Object SQLite; the completed result must survive without re-running.
        const polled = yield* pollComplete(cluster, "email", "replay")
        assert.isDefined(polled, "The completed workflow execution was lost by the isolate restart")
        assert.deepStrictEqual(polled.exit, { _tag: "Success", value: 2 })
        const state = yield* cluster.fetchJson("/state")
        assert.isUndefined(
          state.activityRuns.replay,
          "The Send activity re-ran after the restart instead of replaying its stored result"
        )
      }),
    60_000
  )

  it.effect("wakes a durable clock through the workflow alarm across an isolate restart", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      const started = Date.now()
      yield* cluster.fetchJson("/workflow/execute?name=clock&id=sleeper&discard=true")
      yield* cluster.restart

      yield* cluster.waitUntil(
        "The durable clock alarm did not resume and complete the workflow after the restart",
        Effect.map(pollComplete(cluster, "clock", "sleeper"), (result) => result !== undefined)
      )
      const polled = yield* pollComplete(cluster, "clock", "sleeper")
      assert.strictEqual(polled.exit._tag, "Success")
      assert.isAtLeast(
        polled.exit.value,
        started + 500,
        "The durable clock completed before its 600 millisecond sleep elapsed"
      )
    }), 60_000)

  it.effect(
    "resumes a suspended workflow when its durable deferred completes after a restart",
    () =>
      Effect.gen(function*() {
        const cluster = yield* makeCluster

        yield* cluster.fetchJson("/workflow/execute?name=door&id=waiting&discard=true")
        yield* cluster.waitUntil(
          "The DoorWorkflow did not suspend on its durable deferred",
          Effect.map(
            cluster.fetchJson("/workflow/poll?name=door&id=waiting"),
            (result) => result._tag === "Suspended"
          )
        )

        yield* cluster.restart

        yield* cluster.fetchJson("/workflow/door-open?id=waiting&value=after-restart")
        yield* cluster.waitUntil(
          "Completing the durable deferred did not resume the suspended workflow after the restart",
          Effect.map(pollComplete(cluster, "door", "waiting"), (result) => result !== undefined)
        )
        const polled = yield* pollComplete(cluster, "door", "waiting")
        assert.deepStrictEqual(polled.exit, { _tag: "Success", value: "after-restart" })
      }),
    60_000
  )

  it.effect("persists queued work in the durable queue and consumes it exactly once", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      // No queue worker is running yet, so the workflow suspends on the
      // durable queue with its item persisted in the queue Durable Object.
      yield* cluster.fetchJson("/workflow/execute?name=queue&id=item&discard=true")
      yield* cluster.waitUntil(
        "The QueueWorkflow did not suspend while its item waited in the durable queue",
        Effect.map(
          cluster.fetchJson("/workflow/poll?name=queue&id=item"),
          (result) => result._tag === "Suspended"
        )
      )

      yield* cluster.restart

      const drained = yield* cluster.fetchJson("/queue/drain?id=item")
      assert.strictEqual(drained.processed, 1, "The queue worker did not receive the persisted item")
      yield* cluster.waitUntil(
        "Processing the queued item did not complete the workflow after the restart",
        Effect.map(pollComplete(cluster, "queue", "item"), (result) => result !== undefined)
      )
      const polled = yield* pollComplete(cluster, "queue", "item")
      assert.deepStrictEqual(polled.exit, { _tag: "Success", value: "processed:item" })
      const state = yield* cluster.fetchJson("/state")
      assert.strictEqual(state.queueRuns.item, 1, "The durable queue item was processed more than once")
    }), 60_000)

  it.effect("persists a workflow interruption", () =>
    Effect.gen(function*() {
      const cluster = yield* makeCluster

      yield* cluster.fetchJson("/workflow/execute?name=door&id=doomed&discard=true")
      yield* cluster.waitUntil(
        "The DoorWorkflow did not suspend before the interrupt",
        Effect.map(
          cluster.fetchJson("/workflow/poll?name=door&id=doomed"),
          (result) => result._tag === "Suspended"
        )
      )

      yield* cluster.fetchJson("/workflow/interrupt?name=door&id=doomed")
      yield* cluster.waitUntil(
        "The workflow interruption was not persisted as a completed execution",
        Effect.map(pollComplete(cluster, "door", "doomed"), (result) => result !== undefined)
      )
      const polled = yield* pollComplete(cluster, "door", "doomed")
      assert.strictEqual(polled.exit._tag, "Failure", "The interrupted workflow did not complete with an interruption")
      assert.include(polled.exit.cause, "interrupt", "The stored exit does not identify the interruption")
    }), 60_000)
})

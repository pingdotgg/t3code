import { assert, describe, it, vi } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as Scheduler from "effect/Scheduler"

describe("Scheduler", () => {
  it("runSyncExit does not create a dispatcher for synchronous effects", () => {
    const makeDispatcher = vi.spyOn(Scheduler.MixedScheduler.prototype, "makeDispatcher")
    const exit = Effect.runSyncExit(Effect.sync(() => 1))
    const calls = makeDispatcher.mock.calls.length
    makeDispatcher.mockRestore()

    assert.deepStrictEqual(exit, Exit.succeed(1))
    assert.strictEqual(calls, 0)
  })

  it("runSyncExit flushes dispatcher work after yielding", () => {
    const exit = Effect.runSyncExit(Effect.as(Effect.yieldNow, 1))

    assert.deepStrictEqual(exit, Exit.succeed(1))
  })

  it.effect("MixedScheduler orders by priority (sync)", () =>
    Effect.sync(() => {
      const scheduler = new Scheduler.MixedScheduler("sync").makeDispatcher()
      const order: Array<string> = []

      scheduler.scheduleTask(() => order.push("p0-1"), 0)
      scheduler.scheduleTask(() => order.push("p10-1"), 10)
      scheduler.scheduleTask(() => order.push("p-1-1"), -1)
      scheduler.scheduleTask(() => order.push("p10-2"), 10)
      scheduler.scheduleTask(() => order.push("p0-2"), 0)

      assert.deepStrictEqual(order, [])

      scheduler.flush()

      assert.deepStrictEqual(order, [
        "p-1-1",
        "p0-1",
        "p0-2",
        "p10-1",
        "p10-2"
      ])
    }))

  it.effect("MixedScheduler is FIFO within a priority", () =>
    Effect.sync(() => {
      const scheduler = new Scheduler.MixedScheduler("sync").makeDispatcher()
      const order: Array<number> = []

      scheduler.scheduleTask(() => order.push(1), 5)
      scheduler.scheduleTask(() => order.push(2), 5)
      scheduler.scheduleTask(() => order.push(3), 5)

      scheduler.flush()

      assert.deepStrictEqual(order, [1, 2, 3])
    }))

  it.effect("PreventSchedulerYield disables shouldYield checks", () =>
    Effect.gen(function*() {
      let calls = 0
      const scheduler: Scheduler.Scheduler = {
        executionMode: "sync",
        shouldYield: () => {
          calls++
          return false
        },
        makeDispatcher() {
          return {} as any
        }
      }

      yield* Effect.sync(() => undefined).pipe(
        Effect.provideService(Scheduler.Scheduler, scheduler)
      )
      assert.strictEqual(calls > 0, true)

      calls = 0
      yield* Effect.sync(() => undefined).pipe(
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.provideService(Scheduler.PreventSchedulerYield, true)
      )
      assert.strictEqual(calls, 0)
    }))
})

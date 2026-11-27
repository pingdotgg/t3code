import type { DurableObjectProgramState } from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import {
  makeClusterDurableQueueProgram,
  makeClusterEntityProgram,
  makeClusterSingletonProgram,
  makeClusterWorkflowProgram
} from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import { encodeName } from "@effect/platform-cloudflare/internal/clusterName"
import { registerSingleton } from "@effect/platform-cloudflare/internal/singletonRegistry"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"

class FakeSql {
  earliestDeliverAt: number | null = null
  earliestClockWakeUp: number | null = null
  earliestLeaseExpiry: number | null = null
  singletonState: { name: string | null; wake_at: number | null } | undefined

  exec(query: string) {
    let rows: Array<Record<string, unknown>> = []
    if (query.includes("min(deliver_at)")) {
      rows = [{ deliver_at: this.earliestDeliverAt }]
    } else if (query.includes("min(wake_up)")) {
      rows = [{ wake_up: this.earliestClockWakeUp }]
    } else if (query.includes("min(lease_until)")) {
      rows = [{ lease_until: this.earliestLeaseExpiry }]
    } else if (query.includes("UPDATE singleton_state SET wake_at = NULL")) {
      if (this.singletonState !== undefined) this.singletonState.wake_at = null
    } else if (query.includes("FROM singleton_state")) {
      rows = this.singletonState === undefined ? [] : [this.singletonState]
    }
    return { toArray: () => rows }
  }
}

class FakeState {
  readonly sql = new FakeSql()
  readonly alarms: Array<number> = []
  alarmError: Error | undefined
  deletedAlarms = 0
  name: string | undefined

  constructor(name?: string) {
    this.name = name
  }

  get state(): DurableObjectProgramState {
    const sql = this.sql
    const alarms = this.alarms
    return {
      id: { name: this.name },
      storage: {
        sql,
        getAlarm: () => Promise.resolve(null),
        setAlarm: (scheduledTime: number) => {
          if (this.alarmError !== undefined) return Promise.reject(this.alarmError)
          alarms.push(scheduledTime)
          return Promise.resolve()
        },
        deleteAlarm: () => {
          this.deletedAlarms++
          return Promise.resolve()
        }
      } as unknown as DurableObjectProgramState["storage"],
      exports: {},
      waitUntil: () => {}
    }
  }
}

describe("CloudflareDurableObjectPrograms", () => {
  const constructors = [
    ["entity", makeClusterEntityProgram],
    ["workflow", makeClusterWorkflowProgram],
    ["queue", makeClusterDurableQueueProgram],
    ["singleton", makeClusterSingletonProgram]
  ] as const

  for (const [kind, make] of constructors) {
    const pendingState = () => {
      const fake = new FakeState(kind === "singleton" ? "Singleton/alarm-test" : encodeName("Test", "1"))
      fake.sql.earliestDeliverAt = 2_000
      fake.sql.earliestClockWakeUp = 2_000
      fake.sql.earliestLeaseExpiry = 2_000
      fake.sql.singletonState = { name: "Singleton/alarm-test", wake_at: 2_000 }
      return fake
    }

    it.effect(`${kind} propagates failure to re-arm persisted work`, () =>
      Effect.gen(function*() {
        const fake = pendingState()
        const error = new Error("alarm storage unavailable")
        fake.alarmError = error
        const construction: Effect.Effect<unknown> = make(fake.state)
        const exit = yield* Effect.exit(construction)
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          assert.deepStrictEqual(Cause.squash(exit.cause), error)
        }
      }))
  }

  describe("makeClusterSingletonProgram", () => {
    it.effect("observes a pending wake added after constructing the alarm Effect", () =>
      Effect.gen(function*() {
        let runs = 0
        registerSingleton("program-deferred-state", {
          run: Effect.sync(() => {
            runs++
          }),
          context: Context.empty()
        })
        const fake = new FakeState("Singleton/program-deferred-state")
        const program = yield* makeClusterSingletonProgram(fake.state)
        const alarm = program.alarm()
        fake.sql.singletonState = { name: "Singleton/program-deferred-state", wake_at: 1_000 }
        yield* alarm
        assert.strictEqual(runs, 1)
        assert.strictEqual(fake.sql.singletonState.wake_at, null)
        // Reusing the same Effect must observe the now-cleared pending wake.
        yield* alarm
        assert.strictEqual(runs, 1)
        assert.strictEqual(fake.deletedAlarms, 1)
      }))
  })
})

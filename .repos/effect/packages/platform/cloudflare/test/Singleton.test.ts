import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types"
import type { EntityAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { armAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { makeSingletonRuntime } from "@effect/platform-cloudflare/internal/singletonRuntime"
import {
  beginSingletonWake,
  ensureSingletonStorage,
  loadSingletonState,
  rememberSingletonName
} from "@effect/platform-cloudflare/internal/singletonStorage"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"

class FakeSql {
  readonly statements: Array<string> = []
  name: string | undefined
  wakeAt: number | null = null

  exec(query: string, ...bindings: Array<unknown>) {
    this.statements.push(query)
    if (query.startsWith("CREATE")) return this.rows([])
    if (query.startsWith("SELECT name, wake_at")) {
      return this.rows(
        this.name === undefined && this.wakeAt === null
          ? []
          : [{ name: this.name ?? null, wake_at: this.wakeAt }]
      )
    }
    if (query.includes("INSERT INTO singleton_state (id, name)")) {
      this.name = String(bindings[0])
      return this.rows([])
    }
    if (query.includes("INSERT INTO singleton_state (id, wake_at)")) {
      this.wakeAt = Number(bindings[0])
      return this.rows([])
    }
    if (query.startsWith("UPDATE singleton_state SET wake_at = NULL")) {
      this.wakeAt = null
      return this.rows([])
    }
    throw new Error(`Unexpected SQL: ${query}`)
  }

  private rows(rows: Array<Record<string, unknown>>) {
    return { toArray: () => rows }
  }

  get sql(): SqlStorage {
    return this as unknown as SqlStorage
  }
}

class FakeAlarm {
  readonly setCalls: Array<number> = []
  deleteCalls = 0
  current: number | null = null

  getAlarm() {
    return Promise.resolve(this.current)
  }

  setAlarm(scheduledTime: number) {
    this.setCalls.push(scheduledTime)
    this.current = scheduledTime
    return Promise.resolve()
  }

  deleteAlarm() {
    this.deleteCalls++
    this.current = null
    return Promise.resolve()
  }

  get alarm(): Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm"> {
    return this as unknown as Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">
  }
}

describe("Singleton", () => {
  it.effect("re-arms and completes a wake left pending by isolate loss", () => {
    const sql = new FakeSql()
    const alarm = new FakeAlarm()
    ensureSingletonStorage(sql.sql)
    rememberSingletonName(sql.sql, "Singleton/recovery")
    assert.isTrue(beginSingletonWake(sql.sql, 50))

    return Effect.gen(function*() {
      const pending = loadSingletonState(sql.sql)
      assert.deepStrictEqual(pending, { name: "Singleton/recovery", wakeAt: 50 })
      yield* armAlarm(alarm as unknown as EntityAlarm, pending.wakeAt!)

      let runs = 0
      const runtime = makeSingletonRuntime({
        sql: sql.sql,
        alarm: alarm.alarm,
        now: () => 100,
        run: Effect.sync(() => runs++)
      })
      yield* Effect.promise(() => runtime.runAlarm())

      assert.strictEqual(runs, 1)
      assert.deepStrictEqual(alarm.setCalls, [50])
      assert.strictEqual(alarm.current, null)
      assert.deepStrictEqual(loadSingletonState(sql.sql), { name: "Singleton/recovery", wakeAt: undefined })
    })
  })

  it.effect("keeps the watchdog armed when the alarm fires during a run", () =>
    Effect.gen(function*() {
      const sql = new FakeSql()
      const alarm = new FakeAlarm()
      let now = 100
      // Cloudflare consumes an alarm when it fires, then runs the handler.
      const fireAlarm = (runtime: ReturnType<typeof makeSingletonRuntime>) =>
        Effect.promise(() => {
          assert.isNotNull(alarm.current, "No alarm is armed to wake the singleton")
          now = Math.max(now, alarm.current!)
          alarm.current = null
          return runtime.runAlarm()
        })

      const started = yield* Deferred.make<void>()
      const gated = makeSingletonRuntime({
        sql: sql.sql,
        alarm: alarm.alarm,
        now: () => now,
        run: Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
      })
      void gated.wake()
      yield* Deferred.await(started)
      assert.isNotNull(alarm.current, "The wake armed no watchdog")
      assert.isAbove(alarm.current!, now)

      yield* fireAlarm(gated)
      assert.isNotNull(alarm.current, "The alarm fired during the run left no watchdog armed")
      assert.isAbove(alarm.current!, now)

      // Isolate loss: the gated run is gone and a fresh runtime handles the alarm.
      let runs = 0
      const recovered = makeSingletonRuntime({
        sql: sql.sql,
        alarm: alarm.alarm,
        now: () => now,
        run: Effect.sync(() => {
          runs++
        })
      })
      yield* fireAlarm(recovered)

      assert.strictEqual(runs, 1)
      assert.strictEqual(loadSingletonState(sql.sql).wakeAt, undefined)
    }))
})

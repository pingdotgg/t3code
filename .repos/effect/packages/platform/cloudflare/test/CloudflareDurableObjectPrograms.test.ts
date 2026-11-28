import type { DurableObjectStorage } from "@cloudflare/workers-types"
import type { DurableObjectProgramState } from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import {
  makeClusterDurableQueueProgram,
  makeClusterEntityProgram,
  makeClusterSingletonProgram,
  makeClusterWorkflowProgram
} from "@effect/platform-cloudflare/CloudflareDurableObjectPrograms"
import { encodeName } from "@effect/platform-cloudflare/internal/clusterName"
import { registerEntity, unregisterEntity } from "@effect/platform-cloudflare/internal/entityRegistry"
import type { EntityRegistration } from "@effect/platform-cloudflare/internal/entityRegistry"
import {
  ensureEntityStorage,
  rememberEntityName,
  saveKeepAlive
} from "@effect/platform-cloudflare/internal/entityStorage"
import { registerSingleton } from "@effect/platform-cloudflare/internal/singletonRegistry"
import {
  addParent,
  createExecution,
  ensureWorkflowStorage,
  saveClock,
  saveCompletion
} from "@effect/platform-cloudflare/internal/workflowStorage"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit } from "effect"
import { ClusterSchema, Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { SqliteStorage } from "./fixtures/sqliteStorage.ts"

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

interface LoopbackCall {
  readonly scope: string
  readonly name: string
  readonly method: string
}

const makeExportedState = Effect.fnUntraced(function*(name: string, jurisdiction?: string) {
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close())
  )
  const storage = new SqliteStorage(database)
  const called = yield* Deferred.make<LoopbackCall>()
  const scoped = (scope: string) => ({
    getByName: (target: string) => {
      const record = <A>(method: string, result: Promise<A>) => () => {
        Deferred.doneUnsafe(called, Exit.succeed({ scope, name: target, method }))
        return result
      }
      return {
        hold: record("hold", new Promise<void>(() => {})),
        resume: record("resume", Promise.resolve()),
        deliverReply: record("deliverReply", Promise.resolve(true))
      }
    }
  })
  const namespace = { ...scoped("unrestricted"), jurisdiction: scoped }
  const state: DurableObjectProgramState = {
    id: { name, jurisdiction },
    storage: storage as unknown as DurableObjectStorage,
    exports: { ClusterEntity: namespace, ClusterWorkflow: namespace },
    waitUntil: () => {}
  }
  return { state, storage, called: Deferred.await(called) }
})

const registerProbe = Effect.fnUntraced(function*(type: string) {
  const entity = Entity.make(type, [Rpc.make("Ping").annotate(ClusterSchema.Persisted, true)])
  const registration: EntityRegistration = {
    entity,
    keepAliveHeartbeat: 30_000,
    build: Effect.succeed(entity.of({ Ping: () => Effect.void })),
    options: undefined,
    context: Context.empty()
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => registerEntity(type, registration)),
    () => Effect.sync(() => unregisterEntity(type, registration))
  )
})

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

  describe("makeClusterWorkflowProgram", () => {
    it.effect("skips leftover clock restoration after completion without clearing a pending parent guard", () =>
      Effect.gen(function*() {
        const { called, state, storage } = yield* makeExportedState(encodeName("Child", "c1"))
        ensureWorkflowStorage(storage.sql)
        createExecution(storage.sql, "Child", "c1", "{}")
        addParent(storage.sql, { workflowName: "Parent", executionId: "p1" })
        saveClock(storage.sql, "long", "long/deferred", 180_000)
        saveCompletion(storage.sql, JSON.stringify({ _tag: "Complete" }))
        storage.alarm = 60_000

        const program = yield* makeClusterWorkflowProgram(state)
        assert.strictEqual(storage.alarm, 60_000)

        yield* program.alarm()
        yield* called
        assert.strictEqual(storage.alarm, null)

        const cold = yield* makeClusterWorkflowProgram(state)
        assert.strictEqual(yield* cold.poll(), JSON.stringify({ _tag: "Complete" }))
        assert.strictEqual(storage.alarm, null)
      }))

    it.effect("re-arms a pending clock on construction and indexes clock lookups over fired rows", () =>
      Effect.gen(function*() {
        const { state, storage } = yield* makeExportedState(encodeName("ClockScan", "c1"))
        const database = storage.database
        // Pre-existing storage without the pending-clock index.
        database.exec(`CREATE TABLE workflow_clocks (
          name TEXT PRIMARY KEY,
          deferred_name TEXT NOT NULL,
          wake_up INTEGER NOT NULL,
          fired INTEGER NOT NULL DEFAULT 0
        )`)
        database.exec(`INSERT INTO workflow_clocks (name, deferred_name, wake_up, fired) VALUES
          ('fired', 'DurableClock/fired', 1000, 1),
          ('pending', 'DurableClock/pending', 100000, 0)`)

        const queries: Array<{ readonly query: string; readonly bindings: Array<unknown> }> = []
        const exec = storage.sql.exec
        storage.sql.exec = ((query: string, ...bindings: Array<unknown>) => {
          if (/^\s*SELECT\b/i.test(query) && query.includes("workflow_clocks")) {
            queries.push({ query, bindings })
          }
          return exec.call(storage.sql, query, ...bindings)
        }) as typeof storage.sql.exec

        const program = yield* makeClusterWorkflowProgram(state)
        assert.strictEqual(storage.alarm, 100_000)
        const onConstruct = queries.length
        assert.isAbove(onConstruct, 0)

        yield* program.alarm()
        assert.strictEqual(storage.alarm, 100_000)
        assert.isAbove(queries.length, onConstruct)

        const partialIndexes = new Set(
          (database.prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_clocks' AND sql IS NOT NULL"
          ).all() as Array<{ readonly name: string; readonly sql: string }>)
            .filter((index) => /\bWHERE\b[\s\S]*\bfired\s*=\s*0\b/i.test(index.sql))
            .map((index) => index.name)
        )
        assert.isAbove(partialIndexes.size, 0, "expected a partial index on pending workflow_clocks rows")

        for (const { bindings, query } of queries) {
          const plan = (database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(
            ...bindings as Array<SQLInputValue>
          ) as Array<{ readonly detail: string }>).map((row) => row.detail)
          assert.isTrue(
            plan.some((detail) => {
              const match = /USING (?:COVERING )?INDEX (\S+)/.exec(detail)
              return match !== null && partialIndexes.has(match[1])
            }),
            `expected clock lookup to use a partial pending index, got: ${plan.join("; ")}`
          )
        }
      }))
  })

  describe("jurisdiction-scoped exports", () => {
    for (const jurisdiction of ["eu", undefined] as const) {
      it.effect(`child workflow wakes its parent (${jurisdiction ?? "unrestricted"})`, () =>
        Effect.gen(function*() {
          const { called, state, storage } = yield* makeExportedState(encodeName("Child", "c1"), jurisdiction)
          ensureWorkflowStorage(storage.sql)
          createExecution(storage.sql, "Child", "c1", "{}")
          addParent(storage.sql, { workflowName: "Parent", executionId: "p1" })
          saveCompletion(storage.sql, JSON.stringify({ _tag: "Complete" }))

          const program = yield* makeClusterWorkflowProgram(state)
          yield* program.alarm()

          assert.deepStrictEqual(yield* called, {
            scope: jurisdiction ?? "unrestricted",
            name: encodeName("Parent", "p1"),
            method: "resume"
          })
        }))
    }

    it.effect("kept-alive entity holds itself in the same jurisdiction", () =>
      Effect.gen(function*() {
        yield* registerProbe("JurisdictionHold")
        const name = encodeName("JurisdictionHold", "k1")
        const { called, state, storage } = yield* makeExportedState(name, "eu")
        ensureEntityStorage(storage.sql)
        rememberEntityName(storage.sql, name)
        yield* saveKeepAlive(storage.sql, true)

        const program = yield* makeClusterEntityProgram(state)
        yield* program.alarm()

        assert.deepStrictEqual(yield* called, { scope: "eu", name, method: "hold" })
      }))

    it.effect("scheduled ask pushes its reply to the caller in the same jurisdiction", () =>
      Effect.gen(function*() {
        yield* registerProbe("JurisdictionReply")
        const caller = encodeName("JurisdictionReply", "caller")
        const { called, state } = yield* makeExportedState(encodeName("JurisdictionReply", "r1"), "eu")
        const program = yield* makeClusterEntityProgram(state)
        const envelope = JSON.stringify({
          _tag: "Request",
          requestId: "0198bd72-6a80-72f1-8d87-000000000001",
          address: { shardId: { group: "default", id: 1 }, entityType: "JurisdictionReply", entityId: "r1" },
          tag: "Ping",
          payload: null,
          headers: {}
        })
        yield* program.invoke(envelope, false, { deliverAt: 1, replyTo: caller })
        yield* program.alarm()

        assert.deepStrictEqual(yield* called, { scope: "eu", name: caller, method: "deliverReply" })
      }))
  })
})

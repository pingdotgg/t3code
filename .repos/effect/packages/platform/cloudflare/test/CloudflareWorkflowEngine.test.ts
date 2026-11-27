import type { SqlStorage } from "@cloudflare/workers-types"
import * as CloudflareWorkflowEngine from "@effect/platform-cloudflare/CloudflareWorkflowEngine"
import { encodeName } from "@effect/platform-cloudflare/internal/clusterName"
import type { EntityAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { makeWorkflowRuntime, type WorkflowRuntime } from "@effect/platform-cloudflare/internal/workflowRuntime"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Layer, Option, Schema } from "effect"
import { RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
  WorkflowProxy,
  WorkflowProxyServer
} from "effect/workflow"

class FakeSql {
  execution: Record<string, unknown> | undefined
  readonly activities = new Map<string, string>()
  readonly deferreds = new Map<string, string>()
  readonly clocks = new Map<string, { deferredName: string; wakeUp: number; fired: boolean }>()

  exec(query: string, ...bindings: Array<unknown>) {
    const rows = this.run(query, bindings)
    return { toArray: () => rows }
  }

  private run(query: string, bindings: Array<unknown>): Array<Record<string, unknown>> {
    if (query.startsWith("CREATE TABLE")) return []
    if (query.includes("INSERT OR IGNORE INTO workflow_execution")) {
      this.execution ??= {
        workflow_name: bindings[0],
        execution_id: bindings[1],
        payload: bindings[2],
        parent_name: bindings[3],
        parent_execution_id: bindings[4],
        result: null,
        resume_pending: 0
      }
      return []
    }
    if (query.includes("SET parent_name")) {
      if (this.execution !== undefined && this.execution.parent_name === null) {
        this.execution.parent_name = bindings[0]
        this.execution.parent_execution_id = bindings[1]
      }
      return []
    }
    if (query.includes("SET resume_pending")) {
      if (this.execution !== undefined) this.execution.resume_pending = bindings[0]
      return []
    }
    if (query.includes("UPDATE workflow_execution")) {
      if (this.execution !== undefined) {
        this.execution.result = bindings[0]
        if (query.includes("resume_pending")) this.execution.resume_pending = bindings[1]
      }
      return []
    }
    if (query.includes("FROM workflow_execution")) {
      return this.execution === undefined ? [] : [this.execution]
    }
    if (query.includes("INSERT OR IGNORE INTO workflow_activities")) {
      if (!this.activities.has(String(bindings[0]))) {
        this.activities.set(String(bindings[0]), String(bindings[1]))
      }
      return []
    }
    if (query.includes("FROM workflow_activities")) {
      const exit = this.activities.get(String(bindings[0]))
      return exit === undefined ? [] : [{ exit }]
    }
    if (query.includes("INSERT INTO workflow_deferreds")) {
      if (!this.deferreds.has(String(bindings[0]))) {
        this.deferreds.set(String(bindings[0]), String(bindings[1]))
      }
      return []
    }
    if (query.includes("FROM workflow_deferreds")) {
      const exit = this.deferreds.get(String(bindings[0]))
      return exit === undefined ? [] : [{ exit }]
    }
    if (query.includes("INSERT OR IGNORE INTO workflow_clocks")) {
      if (!this.clocks.has(String(bindings[0]))) {
        this.clocks.set(String(bindings[0]), {
          deferredName: String(bindings[1]),
          wakeUp: Number(bindings[2]),
          fired: false
        })
      }
      return []
    }
    if (query.includes("min(wake_up)")) {
      const pending = Array.from(this.clocks.values()).filter((clock) => !clock.fired).map((clock) => clock.wakeUp)
      return [{ wake_up: pending.length === 0 ? null : Math.min(...pending) }]
    }
    if (query.includes("wake_up <= ?")) {
      return Array.from(this.clocks)
        .filter(([, clock]) => !clock.fired && clock.wakeUp <= Number(bindings[0]))
        .map(([name, clock]) => ({ name, deferred_name: clock.deferredName }))
    }
    if (query.includes("SET fired = 1")) {
      const clock = this.clocks.get(String(bindings[0]))
      if (clock !== undefined) clock.fired = true
      return []
    }
    throw new Error(`Unexpected SQL: ${query}`)
  }

  get sql(): SqlStorage {
    return this as unknown as SqlStorage
  }
}

class FakeAlarm {
  current: number | null = null

  getAlarm() {
    return Promise.resolve(this.current)
  }
  setAlarm(scheduledTime: number) {
    this.current = scheduledTime
    return Promise.resolve()
  }

  get alarm(): EntityAlarm {
    return this as unknown as EntityAlarm
  }
}

class FakeWorkflowNamespace {
  readonly stores = new Map<string, { readonly sql: FakeSql; readonly alarm: FakeAlarm }>()
  readonly runtimes = new Map<string, WorkflowRuntime>()
  readonly hungResumes = new Set<string>()
  /** `${name}/${method}` calls whose next attempt is lost in transit, as Cloudflare rejects them. */
  readonly lostCalls = new Set<string>()
  readonly background = new Set<Promise<unknown>>()
  now = 0

  store(name: string) {
    let store = this.stores.get(name)
    if (store === undefined) {
      store = { sql: new FakeSql(), alarm: new FakeAlarm() }
      this.stores.set(name, store)
    }
    return store
  }

  getByName(name: string): WorkflowRuntime {
    let runtime = this.runtimes.get(name)
    if (runtime === undefined) {
      const store = this.store(name)
      runtime = makeWorkflowRuntime({
        name,
        sql: store.sql.sql,
        alarm: store.alarm.alarm,
        now: () => this.now,
        waitUntil: (promise) => {
          const tracked: Promise<unknown> = promise.finally(() => this.background.delete(tracked))
          this.background.add(tracked)
        },
        getStub: (stubName) =>
          this.hungResumes.has(stubName)
            ? { ...this.getByName(stubName), resume: () => new Promise<void>(() => {}) }
            : this.getByName(stubName)
      })
      this.runtimes.set(name, runtime)
    }
    return Object.fromEntries(
      Object.entries(runtime).map(([method, value]) => [
        method,
        typeof value !== "function" ? value : (...args: Array<unknown>) =>
          this.lostCalls.delete(`${name}/${method}`)
            ? Promise.reject(Object.assign(new Error("Network connection lost."), { retryable: true }))
            : value(...args)
      ])
    ) as unknown as WorkflowRuntime
  }

  /** Waits until no `waitUntil` work remains, so wakes that should not happen have had their chance. */
  settle() {
    return Effect.promise(async () => {
      for (let idle = 0; idle < 5;) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (this.background.size === 0) {
          idle++
        } else {
          idle = 0
          await Promise.allSettled(Array.from(this.background))
        }
      }
    })
  }

  /** Drops every in-memory runtime, as a crashed or hibernated isolate would. */
  crash() {
    this.runtimes.clear()
  }

  get layer() {
    return CloudflareWorkflowEngine.layer({ workflowNamespace: this as never })
  }
}

const pollUntil = Effect.fnUntraced(function*<
  W extends Workflow.Workflow<any, any, any, any>,
  Tag extends "Complete" | "Suspended"
>(workflow: W, executionId: string, tag: Tag) {
  while (true) {
    const result = yield* workflow.poll(executionId)
    if (Option.isSome(result) && result.value._tag === tag) {
      return result.value as Extract<typeof result.value, { readonly _tag: Tag }>
    }
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
  }
})

describe("CloudflareWorkflowEngine", () => {
  it.effect("retains a parent completion wake across a child restart", () => {
    const namespace = new FakeWorkflowNamespace()
    const Gate = DurableDeferred.make("RetryChild/Gate")
    const Child = Workflow.make("RetryChild", { payload: { id: Schema.String }, idempotencyKey: ({ id }) => id })
    const Parent = Workflow.make("RetryParent", { payload: { id: Schema.String }, idempotencyKey: ({ id }) => id })
    const layer = Layer.merge(
      Child.toLayer(() => DurableDeferred.await(Gate)),
      Parent.toLayer(({ id }) => Child.execute({ id }))
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const parentId = yield* Parent.executionId({ id: "one" })
      const childId = yield* Child.executionId({ id: "one" })
      const childName = encodeName(Child._tag, childId)
      yield* Parent.execute({ id: "one" }, { discard: true })
      yield* pollUntil(Parent, parentId, "Suspended")
      namespace.hungResumes.add(encodeName(Parent._tag, parentId))
      yield* DurableDeferred.succeed(Gate, {
        token: DurableDeferred.tokenFromExecutionId(Gate, { workflow: Child, executionId: childId }),
        value: undefined
      })
      yield* pollUntil(Child, childId, "Complete")
      assert.strictEqual(namespace.store(childName).sql.execution?.resume_pending, 1)
      assert.strictEqual(namespace.store(childName).alarm.current, 60_000)

      namespace.hungResumes.clear()
      namespace.crash()
      namespace.now = 60_000
      namespace.store(childName).alarm.current = null
      yield* Effect.promise(() => namespace.getByName(childName).runAlarm())
      const result = yield* pollUntil(Parent, parentId, "Complete")
      assert(result._tag === "Complete" && Exit.isSuccess(result.exit))
      assert.strictEqual(namespace.store(childName).sql.execution?.resume_pending, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("durably admits an in-flight resume before acknowledging it", () =>
    Effect.gen(function*() {
      const namespace = new FakeWorkflowNamespace()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const Waiting = Workflow.make("AdmittedResume", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Waiting.toLayer(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        )
      ).pipe(Layer.provideMerge(namespace.layer))
      yield* Effect.gen(function*() {
        const id = yield* Waiting.executionId({ id: "one" })
        yield* Waiting.execute({ id: "one" }, { discard: true })
        yield* Deferred.await(started)
        const name = encodeName(Waiting._tag, id)
        yield* Effect.promise(() => namespace.getByName(name).resume())
        assert.strictEqual(namespace.store(name).sql.execution?.resume_pending, 1)
        assert.strictEqual(namespace.store(name).alarm.current, 60_000)
        yield* Deferred.succeed(release, undefined)
        yield* pollUntil(Waiting, id, "Complete")
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(layer))
    }))

  it.effect("routes generated workflow proxy handlers through the encoded Durable Object name", () => {
    const namespace = new FakeWorkflowNamespace()
    const Proxied = Workflow.make("Proxied", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const workflows = [Proxied] as const
    const proxy = WorkflowProxy.toRpcGroup(workflows)
    const workflowLayer = Proxied.toLayer(({ id }) => Effect.succeed(`done-${id}`)).pipe(
      Layer.provideMerge(namespace.layer)
    )

    return Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(proxy)
      const result = yield* client.Proxied({ id: "proxy:id" })
      const executionId = yield* Proxied.executionId({ id: "proxy:id" })

      assert.strictEqual(result, "done-proxy:id")
      assert.deepStrictEqual(Array.from(namespace.stores.keys()), [encodeName("Proxied", executionId)])
    }).pipe(
      Effect.provide(WorkflowProxyServer.layerRpcHandlers(workflows)),
      Effect.provide(workflowLayer)
    )
  })

  it.effect("re-runs an activity when the object is lost mid-activity", () => {
    const namespace = new FakeWorkflowNamespace()
    let invocations = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const Crashing = Workflow.make("Crashing", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Crashing.toLayer(() =>
      Activity.make({
        name: "compute",
        success: Schema.Number,
        execute: Effect.suspend(() => {
          invocations++
          if (invocations === 1) {
            release()
            return Effect.promise(() => new Promise<number>(() => {}))
          }
          return Effect.succeed(42)
        })
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Crashing.executionId({ id: "one" })
      yield* Crashing.execute({ id: "one" }, { discard: true })
      yield* Effect.promise(() => started)

      namespace.crash()
      yield* Crashing.resume(executionId)
      const result = yield* pollUntil(Crashing, executionId, "Complete")
      assert(result._tag === "Complete" && Exit.isSuccess(result.exit))
      assert.strictEqual(result.exit.value, 42)
      assert.strictEqual(invocations, 2)

      // The result is keyed `${name}/${attempt}` in the execution object.
      const store = namespace.stores.get(encodeName("Crashing", executionId))!
      assert.deepStrictEqual(Array.from(store.sql.activities.keys()), ["compute/1"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("restarts a discarded execution from its guard alarm when the object is lost mid-attempt", () => {
    const namespace = new FakeWorkflowNamespace()
    let invocations = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const Lost = Workflow.make("LostDiscarded", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = Lost.toLayer(() =>
      Activity.make({
        name: "compute",
        success: Schema.Number,
        execute: Effect.suspend(() => {
          if (++invocations > 1) return Effect.succeed(42)
          release()
          return Effect.never
        })
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Lost.execute({ id: "one" }, { discard: true })
      yield* Effect.promise(() => started)
      const name = encodeName(Lost._tag, executionId)

      // Nobody awaits a discarded run, so only its alarm can bring it back.
      namespace.crash()
      assert.strictEqual(namespace.store(name).alarm.current, 60_000)
      namespace.now = 60_000
      yield* Effect.promise(() => namespace.getByName(name).runAlarm())
      const result = yield* pollUntil(Lost, executionId, "Complete")
      assert.deepStrictEqual(result, new Workflow.Complete({ exit: Exit.succeed(42) }))
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps the guard alarm armed through a long attempt without replaying it", () =>
    Effect.gen(function*() {
      const namespace = new FakeWorkflowNamespace()
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const Gate = DurableDeferred.make("LongAttempt/Gate")
      let runs = 0
      const Long = Workflow.make("LongAttempt", { payload: {}, idempotencyKey: () => "long" })
      const layer = Long.toLayer(Effect.fnUntraced(function*() {
        runs++
        yield* Activity.make({ name: "slow", execute: started.open.pipe(Effect.andThen(release.await)) })
        yield* DurableDeferred.await(Gate)
      })).pipe(Layer.provideMerge(namespace.layer))

      yield* Effect.gen(function*() {
        const executionId = yield* Long.execute({}, { discard: true })
        const name = encodeName(Long._tag, executionId)
        yield* started.await

        namespace.now = 60_000
        yield* Effect.promise(() => namespace.getByName(name).runAlarm())
        assert.strictEqual(namespace.store(name).alarm.current, 120_000)

        yield* release.open
        yield* pollUntil(Long, executionId, "Suspended")
        yield* namespace.settle()
        assert.strictEqual(runs, 1, "a guard alarm during a live attempt must not replay it")
      }).pipe(Effect.provide(layer))
    }))

  it.effect("stores a discarded child's defect and wakes its parent once", () => {
    const namespace = new FakeWorkflowNamespace()
    let parentRuns = 0
    const ParentGate = DurableDeferred.make("DefectingChildParent/Gate")
    const Parent = Workflow.make("DefectingChildParent", { payload: {}, idempotencyKey: () => "parent" })
    const Child = Workflow.make("DefectingChild", { payload: {}, idempotencyKey: () => "child" })
      .annotate(Workflow.CaptureDefects, false)
    const layer = Layer.merge(
      Parent.toLayer(Effect.fnUntraced(function*() {
        // Ends a parent/child replay loop, so a regression fails instead of spinning.
        if (++parentRuns > 3) return
        yield* Child.execute({}, { discard: true })
        yield* DurableDeferred.await(ParentGate)
      })),
      Child.toLayer(() => Effect.die("boom"))
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      yield* Parent.execute({}, { discard: true })
      yield* namespace.settle()

      const child = yield* Child.poll(yield* Child.executionId({}))
      assert(Option.isSome(child) && child.value._tag === "Complete" && Exit.hasDies(child.value.exit))
      assert.strictEqual(parentRuns, 2, "the stored defect wakes the parent once")
    }).pipe(Effect.provide(layer))
  })

  it.effect("retries a child run lost in transit instead of failing the parent", () => {
    const namespace = new FakeWorkflowNamespace()
    const Child = Workflow.make("TransientChild", {
      payload: {},
      success: Schema.String,
      idempotencyKey: () => "child"
    })
    const Parent = Workflow.make("TransientParent", {
      payload: {},
      success: Schema.String,
      idempotencyKey: () => "parent"
    })
    const layer = Layer.merge(
      Child.toLayer(() => Effect.succeed("child")),
      Parent.toLayer(() => Child.execute({}))
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      namespace.lostCalls.add(`${encodeName(Child._tag, yield* Child.executionId({}))}/run`)
      const executionId = yield* Parent.execute({}, { discard: true })
      let result = yield* Parent.poll(executionId)
      while (Option.isNone(result) || result.value._tag !== "Complete") {
        // Lets the retry delay elapse.
        yield* TestClock.adjust("1 minute")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))
        result = yield* Parent.poll(executionId)
      }
      assert.deepStrictEqual(result.value, new Workflow.Complete({ exit: Exit.succeed("child") }))
    }).pipe(Effect.provide(layer))
  })

  it.effect("resumes a suspended parent when a child workflow completes", () => {
    const namespace = new FakeWorkflowNamespace()
    const Gate = DurableDeferred.make("NestedChild/Gate", { success: Schema.String })
    const Child = Workflow.make("NestedChild", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const Parent = Workflow.make("NestedParent", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.merge(
      Child.toLayer(() => DurableDeferred.await(Gate)),
      Parent.toLayer(Effect.fnUntraced(function*({ id }) {
        const value = yield* Child.execute({ id })
        return `parent-${value}`
      }))
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const parentExecutionId = yield* Parent.executionId({ id: "one" })
      const childExecutionId = yield* Child.executionId({ id: "one" })
      yield* Parent.execute({ id: "one" }, { discard: true })
      yield* pollUntil(Parent, parentExecutionId, "Suspended")
      yield* pollUntil(Child, childExecutionId, "Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, { workflow: Child, executionId: childExecutionId })
      yield* DurableDeferred.succeed(Gate, { token, value: "child" })
      const result = yield* pollUntil(Parent, parentExecutionId, "Complete")
      assert(result._tag === "Complete" && Exit.isSuccess(result.exit))
      assert.strictEqual(result.exit.value, "parent-child")
    }).pipe(Effect.provide(layer))
  })

  it.effect("closes finalizers registered before suspension on completion", () => {
    const namespace = new FakeWorkflowNamespace()
    const Gate = DurableDeferred.make("SuspendedScope/Gate")
    const finalized: Array<number> = []
    let runs = 0
    const Suspends = Workflow.make("SuspendedScope", {
      payload: { id: Schema.String },
      idempotencyKey: ({ id }) => id
    })
    const layer = Suspends.toLayer(() =>
      Effect.gen(function*() {
        const run = ++runs
        yield* Workflow.addFinalizer(() => Effect.sync(() => finalized.push(run)))
        yield* DurableDeferred.await(Gate)
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Suspends.executionId({ id: "one" })
      yield* Suspends.execute({ id: "one" }, { discard: true })
      yield* pollUntil(Suspends, executionId, "Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, { workflow: Suspends, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: undefined })
      yield* pollUntil(Suspends, executionId, "Complete")

      assert.deepStrictEqual(finalized, [2, 1])
    }).pipe(Effect.provide(layer))
  })

  it.effect("closes suspended attempt scopes when an attempt defects", () => {
    const namespace = new FakeWorkflowNamespace()
    const Gate = DurableDeferred.make("SuspendedScopeDefect/Gate")
    const events: Array<number | string> = []
    let runs = 0
    const Defects = Workflow.make("SuspendedScopeDefect", {
      payload: { id: Schema.String },
      idempotencyKey: ({ id }) => id
    }).annotate(Workflow.CaptureDefects, false)
    const layer = Defects.toLayer(() =>
      Effect.gen(function*() {
        const run = ++runs
        yield* Workflow.addFinalizer(() => Effect.sync(() => events.push(run)))
        yield* DurableDeferred.await(Gate)
        if (run === 2) return yield* Effect.die("boom")
        events.push(`end-${run}`)
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Defects.executionId({ id: "one" })
      yield* Defects.execute({ id: "one" }, { discard: true })
      yield* pollUntil(Defects, executionId, "Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, { workflow: Defects, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: undefined })
      const result = yield* pollUntil(Defects, executionId, "Complete")
      assert.isTrue(Exit.hasDies(result.exit), "a defect is a terminal result")
      assert.deepStrictEqual(events, [2, 1], "a defect must close earlier attempts' scopes")
    }).pipe(Effect.provide(layer))
  })

  it.effect("surfaces a defect when a suspended attempt's finalizer dies", () => {
    const namespace = new FakeWorkflowNamespace()
    const Gate = DurableDeferred.make("SuspendedFinalizerDefect/Gate")
    const finalized: Array<number> = []
    let runs = 0
    const Suspends = Workflow.make("SuspendedFinalizerDefect", {
      payload: { id: Schema.String },
      idempotencyKey: ({ id }) => id
    })
    const layer = Suspends.toLayer(() =>
      Effect.gen(function*() {
        const run = ++runs
        yield* Workflow.addFinalizer(() =>
          Effect.gen(function*() {
            finalized.push(run)
            if (run === 1) return yield* Effect.die("finalizer defect")
          })
        )
        yield* DurableDeferred.await(Gate)
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Suspends.executionId({ id: "one" })
      yield* Suspends.execute({ id: "one" }, { discard: true })
      yield* pollUntil(Suspends, executionId, "Suspended")

      const token = DurableDeferred.tokenFromExecutionId(Gate, { workflow: Suspends, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: undefined })
      const result = yield* pollUntil(Suspends, executionId, "Complete")
      assert.isTrue(Exit.hasDies(result.exit), "a dying finalizer must not be stored as success")
      assert.deepStrictEqual(finalized, [2, 1])
    }).pipe(Effect.provide(layer))
  })

  it.effect("persists an interrupted completion when hard-interrupted mid-activity", () => {
    const namespace = new FakeWorkflowNamespace()
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const Hard = Workflow.make("HardInterrupt", {
      payload: { id: Schema.String },
      idempotencyKey: ({ id }) => id
    })
    const layer = Hard.toLayer(() =>
      Activity.make({
        name: "hang",
        execute: Effect.andThen(
          Effect.sync(() => release()),
          Effect.promise(() => new Promise<void>(() => {}))
        )
      })
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const executionId = yield* Hard.executionId({ id: "one" })
      yield* Hard.execute({ id: "one" }, { discard: true })
      yield* Effect.promise(() => started)

      yield* engine.interruptUnsafe(Hard, executionId)
      const result = yield* pollUntil(Hard, executionId, "Complete")
      assert(result._tag === "Complete" && Exit.isFailure(result.exit))
      assert.isTrue(Exit.hasInterrupts(result.exit))
    }).pipe(Effect.provide(layer))
  })

  it.effect("skips later activities after a safe interrupt during an activity", () =>
    Effect.gen(function*() {
      const namespace = new FakeWorkflowNamespace()
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const events: Array<string> = []
      const Running = Workflow.make("SafeInterrupt", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Running.toLayer(Effect.fnUntraced(function*() {
        yield* Activity.make({ name: "a", execute: started.open.pipe(Effect.andThen(release.await)) })
        yield* Activity.make({ name: "b", execute: Effect.sync(() => events.push("b")) })
      })).pipe(Layer.provideMerge(namespace.layer))

      yield* Effect.gen(function*() {
        const executionId = yield* Running.execute({ id: "one" }, { discard: true })
        yield* started.await
        yield* Running.interrupt(executionId)
        yield* release.open
        const result = yield* pollUntil(Running, executionId, "Complete")

        assert.deepStrictEqual(events, [])
        assert(result._tag === "Complete" && Exit.isFailure(result.exit))
        assert.isTrue(Exit.hasInterrupts(result.exit))
      }).pipe(Effect.provide(layer))
    }))

  it.effect("keeps a failure-suspended workflow parked when a discarded child completes", () => {
    const namespace = new FakeWorkflowNamespace()
    let failures = 0
    const ChildGate = DurableDeferred.make("FailureParkedChild/Gate")
    const Parent = Workflow.make("FailureParked", {
      payload: {},
      idempotencyKey: () => "parent"
    }).annotate(Workflow.SuspendOnFailure, true)
    const Child = Workflow.make("FailureParkedChild", {
      payload: {},
      idempotencyKey: () => "child"
    })
    const layer = Layer.merge(
      Parent.toLayer(Effect.fnUntraced(function*() {
        yield* Child.execute({}, { discard: true })
        yield* Activity.make({
          name: "fail",
          execute: Effect.suspend(() => {
            failures++
            return Effect.die("boom")
          })
        })
      })),
      Child.toLayer(() => DurableDeferred.await(ChildGate))
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Parent.execute({}, { discard: true })
      const childId = yield* Child.executionId({})
      yield* pollUntil(Parent, executionId, "Suspended")

      yield* DurableDeferred.succeed(ChildGate, {
        token: DurableDeferred.tokenFromExecutionId(ChildGate, { workflow: Child, executionId: childId }),
        value: undefined
      })
      yield* pollUntil(Child, childId, "Complete")
      yield* namespace.settle()
      assert.strictEqual(failures, 1, "only an explicit resume may replay the failed activity")

      yield* Parent.resume(executionId)
      yield* namespace.settle()
      assert.strictEqual(failures, 2)
    }).pipe(Effect.provide(layer))
  })

  for (const wake of ["deferred", "clock"] as const) {
    it.effect(`keeps a failure-suspended workflow parked when a ${wake} completes`, () => {
      const namespace = new FakeWorkflowNamespace()
      let failures = 0
      const Gate = DurableDeferred.make(`FailureParked/${wake}/Gate`)
      const Failing = Workflow.make(`FailureParked/${wake}`, {
        payload: {},
        idempotencyKey: () => "failing"
      }).annotate(Workflow.SuspendOnFailure, true)

      return Effect.gen(function*() {
        const fail = yield* Deferred.make<void>()
        const layer = Failing.toLayer(Effect.fnUntraced(function*() {
          // Schedules the clock, then lets the test decide when the activity fails.
          yield* Effect.raceAll([DurableClock.sleep({ name: "tick", duration: "1 minute" }), Deferred.await(fail)])
          yield* Activity.make({
            name: "fail",
            execute: Effect.suspend(() => {
              failures++
              return Effect.die("boom")
            })
          })
        })).pipe(Layer.provideMerge(namespace.layer))

        yield* Effect.gen(function*() {
          const executionId = yield* Failing.execute({}, { discard: true })
          const name = encodeName(Failing._tag, executionId)
          // Fail only once the clock is scheduled, so its alarm can wake the run later.
          while (namespace.store(name).alarm.current === null) yield* Effect.yieldNow
          yield* Deferred.succeed(fail, undefined)
          const suspended = yield* pollUntil(Failing, executionId, "Suspended")
          assert.isTrue(suspended._tag === "Suspended" && suspended.failed)

          if (wake === "deferred") {
            yield* DurableDeferred.succeed(Gate, {
              token: DurableDeferred.tokenFromExecutionId(Gate, { workflow: Failing, executionId }),
              value: undefined
            })
          } else {
            namespace.now = 60_000
            yield* Effect.promise(() => namespace.getByName(name).runAlarm())
          }
          yield* namespace.settle()
          assert.strictEqual(failures, 1, "only an explicit resume may replay the failed activity")
          assert.deepStrictEqual(yield* Failing.poll(executionId), Option.some(suspended))

          yield* Failing.resume(executionId)
          yield* namespace.settle()
          assert.strictEqual(failures, 2)
        }).pipe(Effect.provide(layer))
      })
    })
  }

  it.effect("wakes a parent when its failure-suspended child is resumed", () => {
    const namespace = new FakeWorkflowNamespace()
    let attempts = 0
    const Parent = Workflow.make("InheritedCauseParent", {
      payload: {},
      success: Schema.Number,
      idempotencyKey: () => "parent"
    })
    const Child = Workflow.make("InheritedCauseChild", {
      payload: {},
      success: Schema.Number,
      idempotencyKey: () => "child"
    }).annotate(Workflow.SuspendOnFailure, true)
    // Await from an activity, so its own result must not inherit the failure.
    const layer = Layer.merge(
      Parent.toLayer(() => Activity.make({ name: "child", success: Schema.Number, execute: Child.execute({}) })),
      Child.toLayer(() =>
        Activity.make({
          name: "flaky",
          success: Schema.Number,
          execute: Effect.suspend(() => ++attempts === 1 ? Effect.die("boom") : Effect.succeed(attempts))
        })
      )
    ).pipe(Layer.provideMerge(namespace.layer))

    return Effect.gen(function*() {
      const executionId = yield* Parent.execute({}, { discard: true })
      yield* pollUntil(Parent, executionId, "Suspended")

      // The parent carries the child's cause but did not fail itself.
      yield* Child.resume(yield* Child.executionId({}))
      const result = yield* pollUntil(Parent, executionId, "Complete")
      assert.deepStrictEqual(result, new Workflow.Complete({ exit: Exit.succeed(2) }))
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps an explicit resume queued behind an automatic wake", () => {
    const namespace = new FakeWorkflowNamespace()
    let failures = 0
    const Gate = DurableDeferred.make("QueuedWake/Gate")
    const Failing = Workflow.make("QueuedWake", {
      payload: {},
      idempotencyKey: () => "failing"
    }).annotate(Workflow.SuspendOnFailure, true)

    return Effect.gen(function*() {
      const cleaningUp = yield* Latch.make()
      const release = yield* Latch.make()
      const layer = Failing.toLayer(() =>
        Activity.make({
          name: "fail",
          execute: Effect.suspend(() => {
            failures++
            return Effect.die("boom")
          })
        }).pipe(Effect.ensuring(Effect.andThen(cleaningUp.open, release.await)))
      ).pipe(Layer.provideMerge(namespace.layer))

      yield* Effect.gen(function*() {
        const executionId = yield* Failing.execute({}, { discard: true })
        yield* cleaningUp.await
        // The run is still cleaning up, so both wakes wait for it to finish.
        yield* DurableDeferred.succeed(Gate, {
          token: DurableDeferred.tokenFromExecutionId(Gate, { workflow: Failing, executionId }),
          value: undefined
        })
        yield* Failing.resume(executionId)
        yield* release.open
        yield* namespace.settle()
        assert.strictEqual(failures, 2, "the explicit resume must replay the failed activity once")
      }).pipe(Effect.provide(layer))
    })
  })

  for (const outcome of ["completes", "defects"] as const) {
    it.effect(`does not wake the parent when a detached child ${outcome}`, () => {
      const namespace = new FakeWorkflowNamespace()
      let parentRuns = 0
      const ParentGate = DurableDeferred.make(`DetachedParent/${outcome}/Gate`)
      const ChildGate = DurableDeferred.make(`DetachedChild/${outcome}/Gate`)
      const Parent = Workflow.make(`DetachedParent/${outcome}`, {
        payload: {},
        idempotencyKey: () => "parent"
      })
      const Child = Workflow.make(`DetachedChild/${outcome}`, {
        payload: {},
        success: Schema.Number,
        idempotencyKey: () => "child"
      })
      const layer = Layer.merge(
        Parent.toLayer(Effect.fnUntraced(function*() {
          parentRuns++
          yield* Child.execute({}, { discard: true, detached: true })
          yield* DurableDeferred.await(ParentGate)
        })),
        // An unencodable success fails the run itself instead of completing it.
        Child.toLayer(() => Effect.as(DurableDeferred.await(ChildGate), outcome === "defects" ? "bad" as never : 1))
      ).pipe(Layer.provideMerge(namespace.layer))

      return Effect.gen(function*() {
        const executionId = yield* Parent.execute({}, { discard: true })
        const childId = yield* Child.executionId({})
        yield* pollUntil(Parent, executionId, "Suspended")
        yield* pollUntil(Child, childId, "Suspended")
        assert.strictEqual(parentRuns, 1)

        yield* DurableDeferred.succeed(ChildGate, {
          token: DurableDeferred.tokenFromExecutionId(ChildGate, { workflow: Child, executionId: childId }),
          value: undefined
        })
        yield* namespace.settle()
        if (outcome === "completes") {
          const child = yield* Child.poll(childId)
          assert(Option.isSome(child) && child.value._tag === "Complete")
        }
        assert.strictEqual(parentRuns, 1, "a detached child must not wake its parent")
      }).pipe(Effect.provide(layer))
    })
  }
})

describe("deferred self-completion", () => {
  for (const failure of [false, true]) {
    it.live(failure ? "failure" : "success", () =>
      Effect.gen(function*() {
        const namespace = new FakeWorkflowNamespace()
        const signal = DurableDeferred.make("signal", { success: Schema.String, error: Schema.String })
        const read = yield* Latch.make()
        const cleanup = yield* Latch.make()
        const release = yield* Latch.make()
        const events: Array<string> = []
        let runs = 0
        const workflow = Workflow.make(`SelfCompletion/${failure ? "failure" : "success"}`, {
          payload: {},
          success: Schema.String,
          error: Schema.String,
          idempotencyKey: () => "one"
        })
        const layer = workflow.toLayer(() =>
          Effect.gen(function*() {
            const run = ++runs
            events.push(`start-${run}`)
            const engine = yield* WorkflowEngine.WorkflowEngine
            return yield* DurableDeferred.raceAll({
              name: "race",
              success: Schema.String,
              error: Schema.String,
              effects: [
                DurableDeferred.await(signal),
                read.await.pipe(
                  Effect.andThen(Effect.yieldNow),
                  Effect.andThen(failure ? Effect.fail("boom") : Effect.succeed("ok")),
                  DurableDeferred.into(signal),
                  // Successful completion must preempt this producer and replay the run.
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    run === 1
                      ? Effect.gen(function*() {
                        events.push("cleanup-start")
                        yield* cleanup.open
                        yield* release.await
                        events.push("cleanup-end")
                      })
                      : Effect.void
                  )
                )
              ]
            }).pipe(
              Effect.provideService(WorkflowEngine.WorkflowEngine, {
                ...engine,
                deferredResult: (deferred) =>
                  engine.deferredResult(deferred).pipe(
                    Effect.tap(() => deferred.name === signal.name ? read.open : Effect.void)
                  )
              }),
              Effect.ensuring(Effect.sync(() => events.push(`end-${run}`)))
            )
          })
        ).pipe(Layer.provideMerge(namespace.layer))

        yield* Effect.gen(function*() {
          const execution = yield* workflow.execute({}).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
          if (!failure) {
            yield* cleanup.await
            for (let i = 0; i < 20; i++) yield* Effect.yieldNow
            assert.deepStrictEqual(events, ["start-1", "cleanup-start"], "replay must wait for cleanup")
            yield* release.open
          }
          const result = yield* Fiber.join(execution)
          if (failure) {
            assert.ok(Exit.isFailure(result))
            assert.strictEqual(result.cause.reasons.length, 1)
            const reason = result.cause.reasons[0]
            assert.ok(Cause.isFailReason(reason))
            assert.strictEqual(reason.error, "boom")
          } else {
            assert.deepStrictEqual(result, Exit.succeed("ok"))
            assert.deepStrictEqual(events, ["start-1", "cleanup-start", "cleanup-end", "end-1", "start-2", "end-2"])
          }
        }).pipe(Effect.provide(layer))
      }), 5_000)
  }
})

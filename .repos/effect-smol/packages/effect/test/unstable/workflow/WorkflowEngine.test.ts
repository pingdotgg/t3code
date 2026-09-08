import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"

describe("WorkflowEngine", () => {
  const IncrementWorkflow = Workflow.make("WorkflowEngine/IncrementWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  })

  const IncrementWorkflowLayer = IncrementWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  class ClassWorkflow extends Workflow.make("WorkflowEngine/ClassWorkflow", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  }) {}

  const ClassWorkflowLayer = ClassWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

  const DeferredRaceWorkflow = Workflow.make("WorkflowEngine/DeferredRaceWorkflow", {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id
  })

  const DeferredRaceGate = DurableDeferred.make("WorkflowEngine/DeferredRaceGate", {
    success: Schema.String
  })

  let deferredRaceRuns = 0
  const DeferredRaceWorkflowLayer = DeferredRaceWorkflow.toLayer(() =>
    Effect.suspend(() => {
      deferredRaceRuns++
      return DurableDeferred.raceAll({
        name: "memory-deferred-race",
        success: Schema.String,
        error: Schema.Never,
        effects: [
          DurableDeferred.await(DeferredRaceGate),
          Effect.sleep("10 seconds").pipe(Effect.as("activity"))
        ]
      })
    })
  )

  it.effect("layer executes and polls workflows", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })
      const result = yield* IncrementWorkflow.execute({ value: 1 })
      const polled = yield* IncrementWorkflow.poll(executionId)

      assert.strictEqual(result, 2)
      assert(Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isSuccess(polled.value.exit))
      assert.strictEqual(polled.value.exit.value, 2)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("discard returns the deterministic execution ID", () =>
    Effect.gen(function*() {
      const executionId = yield* IncrementWorkflow.executionId({ value: 1 })
      const discardedExecutionId = yield* IncrementWorkflow.execute({ value: 1 }, { discard: true })

      assert.strictEqual(discardedExecutionId, executionId)
    }).pipe(
      Effect.provide(IncrementWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("supports class extension", () =>
    Effect.gen(function*() {
      const result = yield* ClassWorkflow.execute({ value: 1 })

      assert.strictEqual(ClassWorkflow._tag, "WorkflowEngine/ClassWorkflow")
      assert.strictEqual(result, 2)
    }).pipe(
      Effect.provide(ClassWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("layerMemory wakes an active workflow when a durable deferred completes", () =>
    Effect.gen(function*() {
      const payload = { id: "memory-deferred-race" }
      const executionId = yield* DeferredRaceWorkflow.executionId(payload)
      const fiber = yield* DeferredRaceWorkflow.execute(payload).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      // Park the deferred branch before completing it.
      yield* TestClock.adjust(1)
      yield* TestClock.adjust(1)
      const token = DurableDeferred.tokenFromExecutionId(DeferredRaceGate, {
        workflow: DeferredRaceWorkflow,
        executionId
      })
      yield* DurableDeferred.succeed(DeferredRaceGate, { token, value: "signal" })
      // Require the wake to settle before the sleeper.
      let polled = yield* DeferredRaceWorkflow.poll(executionId)
      while (Option.isNone(polled) || polled.value._tag !== "Complete") {
        yield* Effect.yieldNow
        polled = yield* DeferredRaceWorkflow.poll(executionId)
      }

      // Let the caller's suspended-retry loop pick up a replayed result.
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* Fiber.join(fiber), "signal")
      // Usually the completion preempts the parked run (2 runs); under load
      // it can land before the branch parks and is read directly (1 run).
      assert(deferredRaceRuns === 1 || deferredRaceRuns === 2)
    }).pipe(
      Effect.provide(DeferredRaceWorkflowLayer.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      ))
    ))

  it.effect("layerMemory propagates interruption when the engine is shut down", () =>
    Effect.gen(function*() {
      const Stuck = Workflow.make("WorkflowEngine/ShutdownWorkflow", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Stuck.toLayer(() => Effect.never).pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      )
      const scope = yield* Scope.make()
      const context = yield* Scope.provide(Layer.build(layer), scope)
      const fiber = yield* Stuck.execute({ id: "one" }).pipe(
        Effect.provideContext(context),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      // Shutting down must interrupt the caller, not report a suspension.
      yield* Scope.close(scope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      assert(Exit.hasInterrupts(exit))
    }))

  it.effect("layerMemory closes finalizers registered before suspension", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("WorkflowEngine/SuspendedScope/Gate")
      const finalized: Array<number> = []
      let runs = 0
      const Suspends = Workflow.make("WorkflowEngine/SuspendedScope", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Suspends.toLayer(() =>
        Effect.gen(function*() {
          const run = ++runs
          yield* Workflow.addFinalizer(() => Effect.sync(() => finalized.push(run)))
          yield* DurableDeferred.await(gate)
        })
      ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))

      yield* Effect.gen(function*() {
        const payload = { id: "one" }
        const executionId = yield* Suspends.execute(payload, { discard: true })
        let result = yield* Suspends.poll(executionId)
        while (Option.isNone(result) || result.value._tag !== "Suspended") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        const token = DurableDeferred.tokenFromExecutionId(gate, { workflow: Suspends, executionId })
        yield* DurableDeferred.succeed(gate, { token, value: void 0 })
        yield* Suspends.execute(payload)

        assert.deepStrictEqual(finalized, [2, 1])
      }).pipe(Effect.provide(layer))
    }))

  it.effect("layerMemory hides deposited interrupts from body finalizers", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("WorkflowEngine/InterruptBodyFinalizer/Gate")
      const observed = yield* Ref.make<ReadonlyArray<boolean>>([])
      const Suspends = Workflow.make("WorkflowEngine/InterruptBodyFinalizer", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Suspends.toLayer(Effect.fnUntraced(function*() {
        const instance = yield* WorkflowEngine.WorkflowInstance
        return yield* DurableDeferred.await(gate).pipe(
          Effect.onExit(() => Ref.update(observed, (values) => [...values, instance.interrupted]))
        )
      })).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))

      yield* Effect.gen(function*() {
        const payload = { id: "one" }
        const executionId = yield* Suspends.execute(payload, { discard: true })
        let result = yield* Suspends.poll(executionId)
        while (Option.isNone(result) || result.value._tag !== "Suspended") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        yield* Suspends.interrupt(executionId)
        while (Option.isNone(result) || result.value._tag !== "Complete") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        assert.deepStrictEqual(yield* Ref.get(observed), [false, false])
      }).pipe(Effect.provide(layer))
    }))

  it.effect("layerMemory exposes deposited interrupts to workflow finalizers", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("WorkflowEngine/InterruptWorkflowFinalizer/Gate")
      const observed = yield* Ref.make<ReadonlyArray<boolean>>([])
      const runs = yield* Ref.make(0)
      const Suspends = Workflow.make("WorkflowEngine/InterruptWorkflowFinalizer", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Suspends.toLayer(Effect.fnUntraced(function*() {
        const run = yield* Ref.getAndUpdate(runs, (run) => run + 1)
        const instance = yield* WorkflowEngine.WorkflowInstance
        if (run === 1) {
          yield* Workflow.addFinalizer(() => Ref.update(observed, (values) => [...values, instance.interrupted]))
        }
        return yield* DurableDeferred.await(gate)
      })).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))

      yield* Effect.gen(function*() {
        const payload = { id: "one" }
        const executionId = yield* Suspends.execute(payload, { discard: true })
        let result = yield* Suspends.poll(executionId)
        while (Option.isNone(result) || result.value._tag !== "Suspended") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        yield* Suspends.interrupt(executionId)
        while (Option.isNone(result) || result.value._tag !== "Complete") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        assert.deepStrictEqual(yield* Ref.get(observed), [true])
      }).pipe(Effect.provide(layer))
    }))

  it.effect("layerMemory preserves interruptUnsafe across a suspended replay", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("WorkflowEngine/InterruptUnsafeReplay/Gate")
      const Suspends = Workflow.make("WorkflowEngine/InterruptUnsafeReplay", {
        payload: { id: Schema.String },
        idempotencyKey: ({ id }) => id
      })
      const layer = Suspends.toLayer(() => DurableDeferred.await(gate)).pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory)
      )

      yield* Effect.gen(function*() {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const payload = { id: "one" }
        const executionId = yield* Suspends.execute(payload, { discard: true })
        let result = yield* Suspends.poll(executionId)
        while (Option.isNone(result) || result.value._tag !== "Suspended") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        yield* engine.interruptUnsafe(Suspends, executionId)
        const token = DurableDeferred.tokenFromExecutionId(gate, { workflow: Suspends, executionId })
        yield* DurableDeferred.succeed(gate, { token, value: void 0 })
        while (Option.isNone(result) || result.value._tag !== "Complete") {
          yield* Effect.yieldNow
          result = yield* Suspends.poll(executionId)
        }

        assert(Option.isSome(result) && result.value._tag === "Complete")
        assert(Exit.hasInterrupts(result.value.exit))
      }).pipe(Effect.provide(layer))
    }))
})

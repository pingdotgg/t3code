import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"

describe("WorkflowEngine", () => {
  const IncrementWorkflow = Workflow.make({
    name: "WorkflowEngine/IncrementWorkflow",
    payload: { value: Schema.Number },
    success: Schema.Number,
    idempotencyKey: ({ value }) => String(value)
  })

  const IncrementWorkflowLayer = IncrementWorkflow.toLayer(({ value }) => Effect.succeed(value + 1))

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
})

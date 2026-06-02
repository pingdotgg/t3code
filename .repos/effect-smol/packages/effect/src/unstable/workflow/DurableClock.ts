/**
 * Workflow-safe sleeps that can be replayed, suspended, and resumed by a
 * workflow engine.
 *
 * Use this module when a workflow needs to pause for a timeout, reminder,
 * deadline, retry delay, or scheduled wake-up. `sleep` keeps very short delays
 * in the current process as an activity, and turns longer delays into durable
 * clocks that the engine can schedule and resume through a durable deferred.
 *
 * **Mental model**
 *
 * A `DurableClock` is a stable timer name, a normalized duration, and the
 * deferred completed when the timer wakes. `sleep` is the workflow-facing
 * helper: zero durations complete immediately, durations at or below the
 * in-memory threshold run with `Effect.sleep` inside an activity, and longer
 * durations are scheduled with the `WorkflowEngine` before awaiting the
 * clock's deferred.
 *
 * **Gotchas**
 *
 * Timer names, durations, and thresholds are part of workflow behavior. Keep
 * them deterministic for a given workflow path, avoid deriving them from
 * ambient wall-clock state, and give distinct logical waits distinct names so
 * replayed executions match the correct scheduled wake-up. Lower the in-memory
 * threshold when a delay must survive the current process rather than relying
 * on an in-process sleep.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import type * as Schema from "../../Schema.ts"
import * as Activity from "./Activity.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/DurableClock"

/**
 * Represents a durable workflow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 4.0.0
 */
export interface DurableClock {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly duration: Duration.Duration
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
}

/**
 * Creates a durable clock definition and its associated deferred wake-up
 * signal.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: {
  readonly name: string
  readonly duration: Duration.Input
}): DurableClock => ({
  [TypeId]: TypeId,
  name: options.name,
  duration: Duration.fromInputUnsafe(options.duration),
  deferred: DurableDeferred.make(`DurableClock/${options.name}`)
})

const EngineTag = Context.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = Context.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

/**
 * Waits inside a workflow, using an in-memory activity for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * @category sleeping
 * @since 4.0.0
 */
export const sleep: (
  options: {
    readonly name: string
    readonly duration: Duration.Input
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined
  }
) => Effect.Effect<
  void,
  never,
  WorkflowEngine | WorkflowInstance
> = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly duration: Duration.Input
  readonly inMemoryThreshold?: Duration.Input | undefined
}) {
  const duration = Duration.fromInputUnsafe(options.duration)
  if (Duration.isZero(duration)) {
    return
  }

  const inMemoryThreshold = options.inMemoryThreshold
    ? Duration.fromInputUnsafe(options.inMemoryThreshold)
    : defaultInMemoryThreshold

  if (Duration.isLessThanOrEqualTo(duration, inMemoryThreshold)) {
    return yield* Activity.make({
      name: `DurableClock/${options.name}`,
      execute: Effect.sleep(duration)
    })
  }

  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const clock = make(options)
  yield* engine.scheduleClock(instance.workflow, {
    executionId: instance.executionId,
    clock
  })
  return yield* DurableDeferred.await(clock.deferred)
})

const defaultInMemoryThreshold = Duration.seconds(60)

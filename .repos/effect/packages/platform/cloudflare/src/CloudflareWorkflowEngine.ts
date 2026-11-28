/**
 * Runs durable workflows on the dedicated workflow Durable Object class.
 *
 * On this path one workflow execution is one Durable Object: the engine
 * encodes `(workflowName, executionId)` into a Durable Object name with the
 * same length-prefix scheme as entities and resolves the object through the
 * workflow namespace binding. Execution state, activity results keyed
 * `${name}/${attempt}`, durable deferred exits, and the clock due table all
 * live on the object's SQLite storage behind its single alarm.
 *
 * Every `DurableClock` is durable on this engine: the in-memory short-sleep
 * path is disabled, so even sub-minute sleeps persist a due row and arm the
 * alarm.
 *
 * @stability experimental
 * @since 4.1.3
 */
import { Clock } from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Workflow from "effect/workflow/Workflow"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import { encodeName } from "./internal/clusterName.ts"
import { callDurableObject } from "./internal/transport.ts"
import {
  CurrentExecutionHandle,
  registerWorkflow,
  unregisterWorkflow,
  type WorkflowRegistration,
  type WorkflowStub
} from "./internal/workflowRegistry.ts"
import { InterruptSignalName } from "./internal/workflowRuntime.ts"
import { decodeExit, decodeResult, encodeExit, encodePayload } from "./internal/workflowWire.ts"

/**
 * The workflow Durable Object namespace binding the engine is built from.
 *
 * @stability experimental
 * @category layers
 * @since 4.1.3
 */
export interface LayerOptions {
  readonly workflowNamespace: DurableObjectNamespace
}

const retryPolicy = Schedule.min([
  Schedule.exponential(200, 1.5),
  Schedule.spaced("1 minute")
])

/**
 * Creates the `WorkflowEngine` service backed by the workflow Durable Object
 * namespace binding.
 *
 * **Details**
 *
 * Inside a workflow Durable Object the engine operates on the local execution
 * handle, so activities and deferred reads never leave the object. Everywhere
 * else it resolves the target execution's object with `getByName` and drives
 * it over the same-Worker binding.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const make = Effect.fnUntraced(function*(options: LayerOptions) {
  const clock = yield* Clock

  // Inside a run the execution's own handle avoids a self-RPC; every other
  // target resolves to its Durable Object stub through the namespace binding.
  //
  // As in `ClusterWorkflowEngine`, a transport failure is retried on an
  // exponential schedule capped at one minute and only then becomes a defect:
  // every call here is idempotent by key, and a permanently unreachable object
  // stalls the caller instead of failing a workflow for good. The object never
  // rejects for application reasons, so a child's own defect arrives as its
  // stored `Complete` result and is never retried.
  const callExecution = <A>(
    workflowName: string,
    executionId: string,
    call: (stub: WorkflowStub) => Promise<A>
  ): Effect.Effect<A> =>
    Effect.flatMap(Effect.serviceOption(CurrentExecutionHandle), (handle) => {
      if (Option.isSome(handle) && handle.value.executionId === executionId) {
        const local = handle.value as WorkflowStub
        return Effect.promise(() => call(local))
      }
      const name = encodeName(workflowName, executionId)
      return callDurableObject({
        resolve: () => options.workflowNamespace.getByName(name) as unknown as WorkflowStub,
        call,
        retry: retryPolicy
      }).pipe(Effect.orDie)
    })

  const localHandle = Effect.fnUntraced(function*(operation: string) {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const handle = yield* Effect.serviceOption(CurrentExecutionHandle)
    if (Option.isNone(handle)) {
      return yield* Effect.die(
        `CloudflareWorkflowEngine: ${operation} is only available inside a workflow Durable Object execution`
      )
    }
    return { instance, handle: handle.value } as const
  })

  return WorkflowEngine.makeUnsafe({
    register: Effect.fnUntraced(function*(workflow, execute) {
      const context = yield* Effect.context<never>()
      const registration: WorkflowRegistration = { workflow, execute, context }
      if (!registerWorkflow(workflow._tag, registration)) return
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unregisterWorkflow(workflow._tag, registration)
        })
      )
    }),

    execute: Effect.fnUntraced(function*(workflow, opts) {
      const context = yield* Effect.context<never>()
      const payload = yield* encodePayload(workflow, opts.payload, context)
      // A detached child keeps no parent, so neither its completion nor a
      // failed run wakes the parent.
      const parent = opts.parent === undefined || opts.detached
        ? undefined
        : { workflowName: opts.parent.workflow._tag, executionId: opts.parent.executionId }
      const text = yield* callExecution(
        workflow._tag,
        opts.executionId,
        (stub) => stub.run(payload, { discard: opts.discard, parent })
      )
      if (opts.discard) return undefined
      return yield* decodeResult(workflow, text, context)
    }) as WorkflowEngine.Encoded["execute"],

    poll: Effect.fnUntraced(function*(workflow, executionId) {
      const context = yield* Effect.context<never>()
      const text = yield* callExecution(workflow._tag, executionId, (stub) => stub.poll())
      if (text === undefined) return Option.none()
      return Option.some(yield* decodeResult(workflow, text, context))
    }),

    interrupt: (workflow, executionId) => callExecution(workflow._tag, executionId, (stub) => stub.interrupt()),

    interruptUnsafe: (workflow, executionId) =>
      callExecution(workflow._tag, executionId, (stub) => stub.interruptUnsafe()),

    resume: (workflow, executionId) => callExecution(workflow._tag, executionId, (stub) => stub.resume()),

    activityExecute: Effect.fnUntraced(function*(activity, attempt) {
      const { handle, instance } = yield* localHandle("Activity execution")
      const key = `${activity.name}/${attempt}`
      const stored = handle.loadActivity(key)
      if (stored !== undefined) {
        return new Workflow.Complete({ exit: yield* decodeExit(stored, Context.empty()) })
      }
      // A pending interrupt replays only to rebuild compensations, so it must
      // not start new activities. Suspending lets the run apply the interrupt.
      if (!instance.interrupted && handle.loadDeferred(InterruptSignalName) !== undefined) {
        instance.suspended = true
        return new Workflow.Suspended({})
      }
      const activityInstance = WorkflowEngine.WorkflowInstance.initial(instance.workflow, instance.executionId)
      activityInstance.interrupted = instance.interrupted
      const result = yield* activity.executeEncoded.pipe(
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance)
      )
      if (result._tag === "Complete") {
        handle.saveActivity(key, yield* encodeExit(result.exit, Context.empty()))
      }
      return result
    }),

    deferredResult: Effect.fnUntraced(function*(deferred) {
      const { handle } = yield* localHandle("DurableDeferred reads")
      const stored = handle.loadDeferred(deferred.name)
      if (stored === undefined) return Option.none()
      return Option.some(yield* decodeExit(stored, Context.empty()))
    }),

    deferredDone: Effect.fnUntraced(function*({ deferredName, executionId, exit, workflowName }) {
      const text = yield* encodeExit(exit, Context.empty())
      const handle = yield* Effect.serviceOption(CurrentExecutionHandle)
      if (Option.isSome(handle) && handle.value.executionId === executionId) {
        return yield* handle.value.completeOwnDeferred(deferredName, text)
      }
      yield* callExecution(workflowName, executionId, (stub) => stub.deferredDone(deferredName, text))
    }),

    scheduleClock: Effect.fnUntraced(function*(workflow, opts) {
      const wakeUp = clock.currentTimeMillisUnsafe() + Math.ceil(Duration.toMillis(opts.clock.duration))
      yield* callExecution(
        workflow._tag,
        opts.executionId,
        (stub) => stub.scheduleClock(opts.clock.name, opts.clock.deferred.name, wakeUp)
      )
    })
  })
})

/**
 * Layer that provides the `WorkflowEngine` backed by the workflow Durable
 * Object namespace binding.
 *
 * **Details**
 *
 * `CloudflareCluster.layer` already includes this layer; use it directly only
 * when the workflow engine is needed without the rest of the cluster.
 *
 * @stability experimental
 * @category layers
 * @since 4.1.3
 */
export const layer = (options: LayerOptions): Layer.Layer<WorkflowEngine.WorkflowEngine> =>
  Layer.effect(WorkflowEngine.WorkflowEngine)(make(options))

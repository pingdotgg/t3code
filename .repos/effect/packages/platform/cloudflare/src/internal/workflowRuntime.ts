/**
 * The workflow Durable Object runtime. One object holds one workflow
 * execution: its payload, run result, activity results keyed
 * `${name}/${attempt}`, durable deferred exits, and the clock due table behind
 * the single alarm. Handlers are looked up in the module-level workflow
 * registry and built once per wake; a crash or hibernation wipes RAM and the
 * next contact replays the execution from SQLite.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as DurableClock from "effect/workflow/DurableClock"
import * as Workflow from "effect/workflow/Workflow"
import * as WorkflowEngine from "effect/workflow/WorkflowEngine"
import { decodeName, encodeName } from "./clusterName.ts"
import { armAlarm, type EntityAlarm } from "./entityStorage.ts"
import {
  CurrentExecutionHandle,
  deferredState,
  getWorkflowRegistration,
  type WorkflowRunOptions,
  type WorkflowStub
} from "./workflowRegistry.ts"
import * as WorkflowStorage from "./workflowStorage.ts"
import { decodePayload, encodeDefectResult, encodeExit, encodeResult } from "./workflowWire.ts"

/** @internal */
export const InterruptSignalName = "Workflow/InterruptSignal"

const resumeGuardMillis = 60_000

let voidExitCache: Promise<string> | undefined
const voidExitText = (): Promise<
  string
> => (voidExitCache ??= Effect.runPromise(encodeExit(Exit.void, Context.empty())))

const mergeWake = (
  current: WorkflowStorage.WakeMode | undefined,
  mode: WorkflowStorage.WakeMode
): WorkflowStorage.WakeMode => current === "explicit" ? current : mode

/** @internal */
export interface WorkflowRuntimeOptions {
  readonly name: string
  readonly sql: SqlStorage
  readonly alarm: EntityAlarm
  readonly now: () => number
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly getStub: (name: string) => WorkflowStub
}

/** @internal */
export interface WorkflowRuntime extends WorkflowStub {
  readonly executionId: string
  readonly loadActivity: (key: string) => string | undefined
  readonly saveActivity: (key: string, exit: string) => void
  readonly loadDeferred: (name: string) => string | undefined
  readonly completeOwnDeferred: (name: string, exit: string) => Effect.Effect<void>
  readonly runAlarm: () => Promise<void>
}

interface Inflight {
  readonly instance: WorkflowEngine.WorkflowInstance["Service"]
  readonly fiber: Fiber.Fiber<{
    readonly result: Workflow.Result<unknown, unknown>
    readonly text: string
  }, unknown>
  readonly promise: Promise<string>
}

/** @internal */
export const makeWorkflowRuntime = (options: WorkflowRuntimeOptions): WorkflowRuntime => {
  const name = decodeName(options.name)
  if (name === undefined) {
    throw new Error("ClusterWorkflow requires a canonical workflow Durable Object name")
  }
  const workflowName = name.type
  const executionId = name.id
  const sql = options.sql

  WorkflowStorage.ensureWorkflowStorage(sql)

  let inflight: Inflight | undefined
  let resumeRequested: WorkflowStorage.WakeMode | undefined
  // Parent of every attempt's scope. As in the memory engine, scopes of
  // attempts that suspended stay open under it, so their finalizers and
  // resources last until the execution completes or an attempt defects.
  let executionScope = Scope.makeUnsafe()

  // The final attempt's scope has already closed with the real exit. Closing
  // the parent closes earlier attempts' scopes in reverse order with
  // `Exit.void`, so their superseded compensations are skipped. A fresh
  // parent is swapped in first: a later replay must not fork from a closed
  // scope, which would run its finalizers as soon as they are registered.
  const closeExecutionScope = Effect.suspend(() => {
    const closing = executionScope
    executionScope = Scope.makeUnsafe()
    return Scope.close(closing, Exit.void)
  })

  const detach = (promise: Promise<unknown>): void => {
    options.waitUntil(promise.then(() => undefined, () => undefined))
  }

  const parseResult = (result: string) => JSON.parse(result) as { readonly _tag?: unknown; readonly failed?: unknown }

  const isComplete = (result: string | undefined): boolean =>
    result !== undefined && parseResult(result)._tag === "Complete"

  // As in the memory engine, only an explicit wake replays a failure suspension.
  const isUnwakeable = (result: string | undefined, mode: WorkflowStorage.WakeMode): boolean => {
    if (result === undefined) return false
    const parsed = parseResult(result)
    return parsed._tag === "Complete" || (mode === "automatic" && parsed.failed === true)
  }

  /**
   * Records a wake durably. A running attempt queues it and decides when it
   * settles, since its result may still become a failure suspension. Returns
   * whether a replay is now pending.
   */
  const requestWake = (mode: WorkflowStorage.WakeMode): boolean => {
    const row = WorkflowStorage.loadExecution(sql)
    if (row === undefined || isComplete(row.result)) return false
    if (inflight === undefined && isUnwakeable(row.result, mode)) return false
    const pending = mergeWake(row.resumePending, mode)
    if (pending !== row.resumePending) WorkflowStorage.setResumePending(sql, pending)
    if (inflight !== undefined) resumeRequested = mergeWake(resumeRequested, mode)
    return true
  }

  const armResumeGuard = Effect.suspend(() => armAlarm(options.alarm, options.now() + resumeGuardMillis))

  const resumeParent = (parent: { readonly workflowName: string; readonly executionId: string }) =>
    Effect.promise(() => options.getStub(encodeName(parent.workflowName, parent.executionId)).resume("automatic")).pipe(
      Effect.sandbox,
      Effect.retry({ times: 5, schedule: Schedule.exponential(200) })
    )

  const logResumeParentFailure = (cause: Cause.Cause<unknown>) =>
    Effect.logError("Workflow parent resume failed", cause)

  const deliverParentWake = Effect.suspend(() => {
    const row = WorkflowStorage.loadExecution(sql)
    if (row === undefined || row.resumePending === undefined || !isComplete(row.result) || row.parent === undefined) {
      return Effect.void
    }
    // Re-arm before sending so a crash or exhausted retries leave another attempt.
    return armResumeGuard.pipe(
      Effect.andThen(
        resumeParent(row.parent).pipe(
          Effect.tap(() => Effect.sync(() => WorkflowStorage.setResumePending(sql, undefined))),
          Effect.catchCause(logResumeParentFailure)
        )
      )
    )
  })

  // An attempt the machinery cannot finish (a defect with `CaptureDefects`
  // off, a payload that no longer decodes, a result that fails to encode, a
  // dying finalizer, a missing registration) completes the execution with the
  // defect, as `ClusterWorkflowEngine` stores an exhausted defect retry. The
  // object never rejects `run` for such a reason, so a caller can tell the
  // child's own defect from a transport failure, and a parent replaying a
  // discarded child finds the result instead of restarting it.
  const failAttempt = (cause: Cause.Cause<unknown>): Promise<string> =>
    Effect.runPromise(Effect.gen(function*() {
      yield* Effect.logError("Workflow execution failed", cause)
      const text = yield* encodeDefectResult(Cause.squash(cause))
      const parent = WorkflowStorage.loadExecution(sql)?.parent
      if (parent !== undefined) yield* armResumeGuard
      WorkflowStorage.saveCompletion(sql, text, parent !== undefined)
      inflight = undefined
      resumeRequested = undefined
      if (parent !== undefined) options.waitUntil(Effect.runPromise(deliverParentWake))
      return text
    }))

  const startAttempt = (row: WorkflowStorage.ExecutionRow): Promise<string> => {
    const registration = getWorkflowRegistration(workflowName)
    if (registration === undefined) {
      return failAttempt(Cause.die(new Error(`No workflow registered for name: ${workflowName}`)))
    }
    const workflow = registration.workflow
    const instance = WorkflowEngine.WorkflowInstance.initial(workflow, executionId, {
      scope: Scope.forkUnsafe(executionScope)
    })
    const execute = decodePayload(workflow, row.payload, registration.context).pipe(
      Effect.flatMap((payload) => registration.execute(payload, executionId) as Effect.Effect<unknown, unknown>),
      Effect.onExit((exit) => {
        const suspendOnFailure = Context.get(workflow.annotations, Workflow.SuspendOnFailure)
        if (!instance.suspended && !(suspendOnFailure && exit._tag === "Failure")) {
          return Effect.void
        }
        if (WorkflowStorage.loadDeferred(sql, InterruptSignalName) === undefined) {
          return Effect.void
        }
        instance.suspended = false
        instance.interrupted = true
        return Effect.withFiber<void>((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
      }),
      Workflow.intoResult,
      (effect) => deferredState.trackRun(instance, effect),
      Effect.flatMap((result) =>
        Effect.map(encodeResult(workflow, result, registration.context), (text) => ({ result, text }))
      ),
      Effect.provideService(DurableClock.InMemoryThreshold, Duration.zero),
      Effect.provideService(CurrentExecutionHandle, runtime)
    )
    const persist = ({ result, text }: {
      readonly result: Workflow.Result<unknown, unknown>
      readonly text: string
    }): Promise<string> =>
      Effect.runPromise(
        Effect.gen(function*() {
          const parent = WorkflowStorage.loadExecution(sql)?.parent
          if (result._tag === "Complete" && parent !== undefined) {
            // Arm before the atomic result/pending save so a persisted
            // completion always has a delivery wake.
            yield* armResumeGuard
          }
          // Stay in flight until the result is saved so a concurrent resume
          // queues behind this attempt instead of replaying alongside it.
          if (result._tag === "Complete") {
            WorkflowStorage.saveCompletion(sql, text, parent !== undefined)
            inflight = undefined
            resumeRequested = undefined
            if (parent !== undefined) options.waitUntil(Effect.runPromise(deliverParentWake))
            return text
          }
          const replay = resumeRequested !== undefined && !isUnwakeable(text, resumeRequested)
            ? resumeRequested
            : undefined
          WorkflowStorage.saveSuspension(sql, text, replay)
          inflight = undefined
          resumeRequested = undefined
          if (replay !== undefined) detach(startAttempt(row))
          return text
        }).pipe(Effect.tapCause(() =>
          Effect.sync(() => {
            inflight = undefined
          })
        ))
      )
    const finish = (attempt: {
      readonly result: Workflow.Result<unknown, unknown>
      readonly text: string
    }): Promise<string> => {
      if (attempt.result._tag !== "Complete") return persist(attempt)
      // Close retained scopes before saving, so a durable completion never
      // has unrun finalizers. A dying finalizer fails the attempt instead.
      return Effect.runPromise(Effect.exit(closeExecutionScope)).then((closed) =>
        Exit.isSuccess(closed) ? persist(attempt) : failAttempt(closed.cause)
      )
    }
    const fiber = Effect.runFork(execute)
    const promise = Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      if (Exit.isSuccess(exit)) return finish(exit.value)
      if (Cause.hasInterruptsOnly(exit.cause) && (instance.interrupted || instance.suspended)) {
        // A hard interrupt (or a completion preempting the fiber after it
        // already produced its result) kills the fiber before it can encode;
        // synthesize the result from the instance state so it still persists.
        const result: Workflow.Result<unknown, unknown> = instance.interrupted
          ? new Workflow.Complete({ exit: exit as Exit.Exit<unknown, unknown> })
          : new Workflow.Suspended({})
        return Effect.runPromise(encodeResult(workflow, result, registration.context))
          .then((text) => finish({ result, text }))
      }
      // A defect ends every retained attempt; a replay starts in fresh scopes.
      // Stay in flight while closing so cleanup precedes any replay.
      return Effect.runPromise(Effect.exit(closeExecutionScope)).then((closed) =>
        failAttempt(Exit.isSuccess(closed) ? exit.cause : Cause.combine(exit.cause, closed.cause))
      )
    })
    inflight = { instance, fiber, promise }
    return promise
  }

  const run = (payload: string, opts: WorkflowRunOptions): Promise<string> => {
    let row = WorkflowStorage.loadExecution(sql)
    if (row === undefined) {
      WorkflowStorage.createExecution(sql, workflowName, executionId, payload, opts.parent)
      row = { workflowName, executionId, payload, parent: opts.parent, result: undefined, resumePending: undefined }
    } else if (opts.parent !== undefined && row.parent === undefined) {
      // An execution started standalone can gain a parent later; keep the
      // first parent so its completion still wakes that parent.
      WorkflowStorage.setParent(sql, opts.parent)
      row = { ...row, parent: opts.parent }
    }
    if (inflight !== undefined) return opts.discard ? Promise.resolve("") : inflight.promise
    if (row.result !== undefined) return Promise.resolve(opts.discard ? "" : row.result)
    // The attempt stays pending under the guard alarm until it persists a
    // result, so an attempt lost with this object is replayed even when no
    // caller awaits it.
    WorkflowStorage.setResumePending(sql, mergeWake(row.resumePending, "automatic"))
    const attempt = startAttempt(row)
    const armed = Effect.runPromise(armResumeGuard)
    if (opts.discard) {
      detach(attempt)
      return armed.then(() => "")
    }
    return Promise.all([attempt, armed]).then(([text]) => text)
  }

  const startPending = (): void => {
    const row = WorkflowStorage.loadExecution(sql)
    if (row === undefined || row.resumePending === undefined || inflight !== undefined) return
    if (isUnwakeable(row.result, row.resumePending)) return
    detach(startAttempt(row))
  }

  const resume = (mode: WorkflowStorage.WakeMode = "explicit"): Promise<void> => {
    if (!requestWake(mode)) return Promise.resolve()
    // Persist and guard the resume before acknowledging it, so an abort after
    // the RPC returns is still recovered.
    return Effect.runPromise(armResumeGuard).then(startPending)
  }

  const completeDeferred = (
    deferredName: string,
    exitText: string,
    mode: WorkflowStorage.WakeMode
  ): Promise<void> => {
    if (!WorkflowStorage.saveDeferred(sql, deferredName, exitText)) return Promise.resolve()
    // Persisted with the exit in the same write batch: if this wake is lost
    // before the replay finishes, the next wake (or the guard alarm) replays
    // the execution. The in-flight request is set synchronously so a settling
    // attempt cannot clear the pending resume without a restart.
    if (!requestWake(mode)) return Promise.resolve()
    return Effect.runPromise(
      armResumeGuard.pipe(Effect.andThen(deferredState.deferredDone(executionId, deferredName)))
    ).then(() => resume(mode))
  }

  const deferredDone = (deferredName: string, exitText: string): Promise<void> =>
    completeDeferred(deferredName, exitText, "automatic")

  // The caller belongs to the run this wake interrupts, so awaiting that run
  // would wait on the caller's own cleanup. As in the memory engine, the wake
  // starts on a separate fiber after the caller continues.
  const completeOwnDeferred = (deferredName: string, exitText: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!WorkflowStorage.saveDeferred(sql, deferredName, exitText) || !requestWake("automatic")) {
        return Effect.void
      }
      const wake = deferredState.deferredDone(executionId, deferredName).pipe(
        Effect.andThen(
          Effect.suspend(() => inflight === undefined ? Effect.promise(() => resume("automatic")) : Effect.void)
        )
      )
      return armResumeGuard.pipe(
        Effect.andThen(Effect.forkDetach(wake)),
        Effect.flatMap((fiber) => Effect.sync(() => detach(Effect.runPromise(Fiber.await(fiber)))))
      )
    })

  const interrupt = (): Promise<void> => {
    const row = WorkflowStorage.loadExecution(sql)
    if (row === undefined || isComplete(row.result)) return Promise.resolve()
    return voidExitText().then((exitText) => completeDeferred(InterruptSignalName, exitText, "explicit"))
  }

  const interruptUnsafe = (): Promise<void> => {
    const current = inflight
    const signalled = interrupt()
    if (current === undefined) return signalled
    current.instance.interrupted = true
    return signalled
      .then(() => Effect.runPromise(Fiber.interrupt(current.fiber)))
      .then(() => undefined)
  }

  const scheduleClock = (clockName: string, deferredName: string, wakeUp: number): Promise<void> => {
    WorkflowStorage.saveClock(sql, clockName, deferredName, wakeUp)
    const earliest = WorkflowStorage.earliestClockWakeUp(sql)
    return earliest === undefined ? Promise.resolve() : Effect.runPromise(armAlarm(options.alarm, earliest))
  }

  const runAlarm = (): Promise<void> =>
    voidExitText().then((voidExit) => {
      const completed = WorkflowStorage.dueClocks(sql, options.now()).filter((clock) => {
        WorkflowStorage.markClockFired(sql, clock.name)
        return WorkflowStorage.saveDeferred(sql, clock.deferredName, voidExit)
      })
      if (completed.length > 0) requestWake("automatic")
      return Effect.runPromise(Effect.forEach(
        completed,
        (clock) => deferredState.deferredDone(executionId, clock.deferredName),
        { discard: true }
      )).then(() => {
        const row = WorkflowStorage.loadExecution(sql)
        const mode = row?.resumePending
        const pending = mode !== undefined && !isUnwakeable(row?.result, mode)
        // A live attempt is not lost: only re-arm the guard. Requesting a wake
        // would replay the attempt once it suspends, for no reason.
        return (pending && inflight === undefined ? resume(mode) : Promise.resolve()).then(() => {
          // While a resume is pending a guard alarm stays armed, so a replay
          // lost with this isolate is retried instead of sleeping forever.
          const targets = [
            WorkflowStorage.earliestClockWakeUp(sql),
            pending ? options.now() + resumeGuardMillis : undefined
          ].filter((target) => target !== undefined)
          if (targets.length === 0) return undefined
          // The alarm that fired is spent, so set the next one outright:
          // `armAlarm` only ever moves an alarm earlier.
          return options.alarm.setAlarm(Math.min(...targets))
        })
      })
    }).then(() => Effect.runPromise(deliverParentWake)).then(() => undefined)

  const runtime: WorkflowRuntime = {
    executionId,
    run,
    poll: () => Promise.resolve(WorkflowStorage.loadExecution(sql)?.result),
    resume,
    interrupt,
    interruptUnsafe,
    deferredDone,
    scheduleClock,
    runAlarm,
    loadActivity: (key) => WorkflowStorage.loadActivity(sql, key),
    saveActivity: (key, exit) => WorkflowStorage.saveActivity(sql, key, exit),
    loadDeferred: (deferredName) => WorkflowStorage.loadDeferred(sql, deferredName),
    completeOwnDeferred
  }

  // Self-heal on wake: a resume recorded by deferredDone but lost with the
  // previous isolate replays now instead of waiting for external contact.
  const pending = WorkflowStorage.loadExecution(sql)?.resumePending
  if (pending !== undefined) {
    void resume(pending)
  }

  return runtime
}

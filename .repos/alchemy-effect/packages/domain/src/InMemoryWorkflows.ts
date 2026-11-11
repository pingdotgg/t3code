import { CurrentActivity, makeCurrentActivity } from "alchemy/WorkflowEncoding";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { Workflow, WorkflowEngine } from "effect/workflow";

/**
 * What the in-memory platform gives its workflow engine: its clock, its work
 * queue, and its timers. Runs and clocks go through these, so a story's
 * `drain` runs sagas to where they wait, and moving its clock fires their sleeps.
 */
export interface Host {
  readonly now: () => number;
  /** Queue a run; it runs in the background, counted as running until it finishes. */
  readonly enqueue: (run: Effect.Effect<void>) => Effect.Effect<void>;
  /** Fire `fire` at `at` on the platform's clock; scheduling the same key again replaces it. */
  readonly timer: (key: string, at: number, fire: Effect.Effect<void>) => Effect.Effect<void>;
  /** Record a run that failed, so a story can report it. */
  readonly failed: (cause: unknown) => void;
  /** Record a run that ended with a defect, so a story can report it. */
  readonly died: (workflow: string, executionId: string, defect: unknown) => void;
}

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

interface Execution {
  readonly workflow: Workflow.Any;
  readonly payload: object;
  readonly parent: { readonly workflow: Workflow.Any; readonly executionId: string } | undefined;
  interrupted: boolean;
  result: Workflow.Complete<unknown, unknown> | undefined;
}

/**
 * A `WorkflowEngine` that keeps every execution's journal in memory and runs
 * on the in-memory platform. Like the Durable Object engine, a run replays the
 * workflow from the top and stops where it waits; the next wake-up runs it again.
 */
export const make = (host: Host): WorkflowEngine.WorkflowEngine["Service"] => {
  const handlers = new Map<string, Execute>();
  const executions = new Map<string, Execution>();
  const activities = new Map<string, Exit.Exit<unknown, unknown>>();
  const deferreds = new Map<string, Exit.Exit<unknown, unknown>>();
  const clocks = new Map<string, number>();

  const keyOf = (workflowName: string, executionId: string) => `${workflowName}/${executionId}`;

  // One run per execution at a time; a wake-up during a run queues the next.
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (key: string) => {
    let lock = locks.get(key);
    if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };

  const run = (key: string): Effect.Effect<void> => lockOf(key).withPermits(1)(runOnce(key));

  const runOnce = (key: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const execution = executions.get(key);
      if (!execution || execution.result) return Effect.void;
      const execute = handlers.get(execution.workflow._tag)!;
      const executionId = key.slice(execution.workflow._tag.length + 1);
      const instance = WorkflowEngine.WorkflowInstance.initial(execution.workflow, executionId);
      return execute(execution.payload, executionId).pipe(
        // An interrupted execution replays to where it waits, then is
        // interrupted there, which fails it and runs its compensations.
        Effect.onExit(() => {
          if (!execution.interrupted) return Effect.void;
          instance.interrupted = true;
          instance.suspended = false;
          return Effect.withFiber((fiber) => fiber.pipe(Fiber.interrupt, Effect.interruptible));
        }),
        Workflow.intoResult,
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
            Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
          ),
        ),
        Effect.flatMap((result) => {
          if (result._tag === "Suspended") return Effect.void;
          execution.result = result;
          if (Exit.isFailure(result.exit)) {
            const reasons = result.exit.cause.reasons;
            const defect = reasons.find((reason) => reason._tag === "Die");
            if (defect?._tag === "Die" && !reasons.some((reason) => reason._tag === "Fail")) {
              host.died(execution.workflow._tag, executionId, defect.defect);
            }
          }
          return execution.parent
            ? wake(keyOf(execution.parent.workflow._tag, execution.parent.executionId))
            : Effect.void;
        }),
        Effect.catchCause((cause) => Effect.sync(() => host.failed(cause))),
      );
    });

  const wake = (key: string) => host.enqueue(run(key));

  const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
    register: (workflow, execute) => Effect.sync(() => void handlers.set(workflow._tag, execute)),

    execute: (workflow, options) =>
      Effect.gen(function* () {
        const key = keyOf(workflow._tag, options.executionId);
        let execution = executions.get(key);
        if (!execution) {
          execution = {
            workflow,
            payload: options.payload,
            parent: options.parent
              ? { workflow: options.parent.workflow, executionId: options.parent.executionId }
              : undefined,
            interrupted: false,
            result: undefined,
          };
          executions.set(key, execution);
          yield* wake(key);
        }
        if (options.discard) return undefined;
        return execution.result ?? Workflow.Suspended.make({});
      }) as Effect.Effect<any>,

    poll: (workflow, executionId) =>
      Effect.sync(() => {
        const execution = executions.get(keyOf(workflow._tag, executionId));
        if (!execution) return Option.none();
        return Option.some(execution.result ?? Workflow.Suspended.make({}));
      }),

    interrupt: (workflow, executionId) =>
      Effect.suspend(() => {
        const key = keyOf(workflow._tag, executionId);
        const execution = executions.get(key);
        if (!execution || execution.result) return Effect.void;
        execution.interrupted = true;
        return wake(key);
      }),

    interruptUnsafe: (workflow, executionId) =>
      Effect.sync(() => {
        const execution = executions.get(keyOf(workflow._tag, executionId));
        if (!execution || execution.result) return;
        execution.interrupted = true;
        execution.result = new Workflow.Complete({ exit: Exit.interrupt() });
      }),

    resume: (workflow, executionId) => wake(keyOf(workflow._tag, executionId)),

    activityExecute: (activity, attempt) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const key = `${keyOf(instance.workflow._tag, instance.executionId)}/${activity.name}/${attempt}`;
        const stored = activities.get(key);
        if (stored) return new Workflow.Complete({ exit: stored });
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        );
        activityInstance.interrupted = instance.interrupted;
        const result = yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkflowEngine.WorkflowInstance, activityInstance),
              Layer.succeed(
                CurrentActivity,
                makeCurrentActivity(instance.workflow._tag, instance.executionId, activity.name),
              ),
            ),
          ),
        );
        if (result._tag === "Complete") activities.set(key, result.exit);
        return result;
      }),

    deferredResult: (deferred) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        return Option.fromNullishOr(
          deferreds.get(`${keyOf(instance.workflow._tag, instance.executionId)}/${deferred.name}`),
        );
      }),

    deferredDone: (options) =>
      Effect.suspend(() => {
        const key = keyOf(options.workflowName, options.executionId);
        const name = `${key}/${options.deferredName}`;
        if (deferreds.has(name)) return Effect.void;
        deferreds.set(name, options.exit);
        return wake(key);
      }),

    // A clock keeps the due time it was first given, however many times the
    // run replays past `DurableClock.sleep`.
    scheduleClock: (workflow, options) =>
      Effect.suspend(() => {
        const key = keyOf(workflow._tag, options.executionId);
        const name = `${key}/${options.clock.name}`;
        if (clocks.has(name)) return Effect.void;
        const due = host.now() + Duration.toMillis(options.clock.duration);
        clocks.set(name, due);
        return host.timer(
          name,
          due,
          engine.deferredDone(options.clock.deferred, {
            workflowName: workflow._tag,
            executionId: options.executionId,
            deferredName: options.clock.deferred.name,
            exit: Exit.void,
          }),
        );
      }),
  });

  return engine;
};

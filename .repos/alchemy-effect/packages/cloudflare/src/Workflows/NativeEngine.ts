import {
  CurrentActivity,
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Activity, Workflow as EffectWorkflow, WorkflowEngine } from "effect/workflow";
import type { Worker } from "../Workers/Worker.ts";
import { Workflow, type WorkflowHandle } from "./Workflow.ts";
import { WorkflowStep } from "./WorkflowRuntime.ts";

/** What each Cloudflare Workflow instance runs: one execution of one Effect workflow. */
interface Invocation {
  readonly workflow: string;
  readonly executionId: string;
  readonly payload: unknown;
}

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

/** The run in progress: its step context, and the clocks it has scheduled. */
class CurrentRun extends Context.Service<
  CurrentRun,
  {
    readonly step: WorkflowStep["Service"];
    readonly context: Context.Context<never>;
    readonly clocks: Map<string, Duration.Duration>;
    readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  }
>()("alchemy/Cloudflare/Workflows/NativeEngine/CurrentRun") {}

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(new Error(`NativeEngine: ${operation} only runs inside a workflow run`)),
  );

/**
 * A name Cloudflare accepts for an instance id or event type: up to 100
 * letters, digits, `-` and `_`.
 */
const nameOf = (...parts: ReadonlyArray<string>) => {
  const name = parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length <= 100) return name;
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${name.slice(0, 91)}-${hash.toString(16).padStart(8, "0")}`;
};

/** Every wait for a signal also waits for this event, which interrupts the run. */
const INTERRUPT = "alchemy-interrupt";

/** A run suspended on a failure waits for this event, which resumes it. */
const RESUME = "alchemy-resume";

/** A defect the workflow doesn't capture, failing its activity's step so Cloudflare retries it. */
interface ActivityDefect {
  readonly _tag: "ActivityDefect";
  readonly message: string;
}

/** What an activity's step records when the activity suspends on a failure. */
const SUSPENDED = "alchemy-suspended";

/** How long a run waits for a signal; Cloudflare's limit for `waitForEvent`. */
const SIGNAL_TIMEOUT = "365 days";

/**
 * Retry a Workflows binding call while the Workflow class is still
 * propagating after a deploy, which Cloudflare reports as "Worker not found",
 * for about a minute.
 */
const inTransit = <A>(call: Effect.Effect<A>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) =>
      String(defect).includes("Worker not found") ? Effect.fail(defect) : Effect.die(defect),
    ),
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
      times: 35,
    }),
    Effect.orDie,
  ) as Effect.Effect<A>;

/**
 * Send an event to an instance, retrying any failure for about a minute: a run
 * takes each signal and interrupt at most once, so sending one again is safe.
 * A finished instance takes no more events, and needs none.
 */
const sendEvent = (
  handle: WorkflowHandle,
  id: string,
  event: { type: string; payload?: unknown },
) =>
  handle.get(id).pipe(
    Effect.flatMap((instance) => instance.sendEvent(event)),
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch((error) =>
      Effect.flatMap(statusOf(handle, id), (status) =>
        status?.status === "complete" ||
        status?.status === "errored" ||
        status?.status === "terminated"
          ? Effect.void
          : Effect.fail(error),
      ),
    ),
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
      times: 35,
    }),
    Effect.orDie,
  ) as Effect.Effect<void>;

/** An instance's status, or undefined if there's no such instance. */
const statusOf = (handle: WorkflowHandle, id: string) =>
  inTransit(handle.get(id).pipe(Effect.flatMap((instance) => instance.status()))).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
  );

/** An instance's result, or undefined while it runs. */
const resultOf = (
  handle: WorkflowHandle,
  workflow: EffectWorkflow.AnyWithProps,
  id: string,
): Effect.Effect<EffectWorkflow.Complete<unknown, unknown> | undefined | null> =>
  Effect.gen(function* () {
    const status = yield* statusOf(handle, id);
    if (status === undefined) return null;
    switch (status.status) {
      case "complete":
        return yield* decodeResult(workflow, status.output as string);
      case "terminated":
        return new EffectWorkflow.Complete({ exit: Exit.interrupt() });
      case "errored":
        return new EffectWorkflow.Complete({
          exit: Exit.die(new Error(status.error?.message ?? `Workflow instance ${id} errored`)),
        });
      default:
        return undefined;
    }
  });

/**
 * Run Effect workflows on Cloudflare Workflows. One Cloudflare Workflow class,
 * `NativeEngine`, runs every workflow the Worker implements; each execution is
 * one instance, named after the workflow and its execution id.
 *
 * Steps run with `step.do`, so a finished step is replayed rather than run
 * again. `DurableClock.sleep` is `step.sleep`, and `DurableDeferred.await`
 * waits for an event that a run's `signal` sends.
 *
 * ### Running workflows on Cloudflare Workflows
 * **Example:** Provide the engine to a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class AppWorker extends Cloudflare.Worker<AppWorker>()(
 *   "AppWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const welcome = yield* Workflows.RunWorkflow(SendWelcome);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* welcome.start({ userId: "u-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(SendWelcomeLive.pipe(Layer.provideMerge(Cloudflare.Workflows.NativeEngine))),
 *   ),
 * ) {}
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Workflows
 */
export const NativeEngine: Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> = Layer.effect(
  WorkflowEngine.WorkflowEngine,
  Effect.gen(function* () {
    const handlers = new Map<
      string,
      { readonly workflow: EffectWorkflow.AnyWithProps; readonly execute: Execute }
    >();
    let engine: WorkflowEngine.WorkflowEngine["Service"];

    const handle = yield* Workflow(
      "NativeEngine",
      Effect.succeed((invocation: Invocation) =>
        Effect.gen(function* () {
          const registration = handlers.get(invocation.workflow);
          if (!registration) {
            return yield* Effect.die(
              new Error(`Workflow ${invocation.workflow} is not hosted here`),
            );
          }
          const step = yield* WorkflowStep;
          const context = yield* Effect.context<never>();
          const { workflow, execute } = registration;
          const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(
            invocation.payload,
          ).pipe(Effect.orDie);
          const instance = WorkflowEngine.WorkflowInstance.initial(
            workflow,
            invocation.executionId,
          );
          const result = yield* execute(payload as object, invocation.executionId).pipe(
            EffectWorkflow.intoResult,
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
                Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
                Layer.succeed(CurrentRun, { step, context, clocks: new Map(), instance }),
              ),
            ),
          );
          // Every wait blocks inside the instance, so a run always finishes.
          if (result._tag === "Suspended") {
            return yield* Effect.die(new Error(`Workflow ${workflow._tag} suspended unexpectedly`));
          }
          return yield* encodeResult(workflow, result.exit);
        }),
      ),
    ) as Effect.Effect<WorkflowHandle, never, Worker>;

    engine = WorkflowEngine.makeUnsafe({
      register: (workflow, execute) =>
        Effect.sync(
          () =>
            void handlers.set(workflow._tag, {
              workflow: workflow as EffectWorkflow.AnyWithProps,
              execute,
            }),
        ),

      execute: (workflow, opts) =>
        Effect.gen(function* () {
          const id = nameOf(workflow._tag, opts.executionId);
          const payload = yield* Schema.encodeEffect(
            payloadCodec(workflow as EffectWorkflow.AnyWithProps),
          )(opts.payload).pipe(Effect.orDie);
          // The same key always names the same run: create it only once.
          if ((yield* statusOf(handle, id)) === undefined) {
            yield* inTransit(
              handle.create({
                id,
                params: { workflow: workflow._tag, executionId: opts.executionId, payload },
              }),
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.flatMap(statusOf(handle, id), (status) =>
                      status === undefined ? Effect.failCause(exit.cause) : Effect.void,
                    ),
              ),
            );
          }
          if (opts.discard) return undefined;
          const run = yield* Effect.serviceOption(CurrentRun);
          if (Option.isNone(run)) {
            const result = yield* resultOf(handle, workflow as EffectWorkflow.AnyWithProps, id);
            return result ?? EffectWorkflow.Suspended.make({});
          }
          // A child workflow: wait for it here, sleeping between checks.
          for (let check = 0; ; check++) {
            const text = yield* run.value.step.do({
              name: `child/${id}/${check}`,
              effect: resultOf(handle, workflow as EffectWorkflow.AnyWithProps, id).pipe(
                Effect.flatMap((result) =>
                  result
                    ? encodeResult(workflow as EffectWorkflow.AnyWithProps, result.exit)
                    : Effect.succeed(""),
                ),
              ),
            });
            if (text !== "") {
              return yield* decodeResult(workflow as EffectWorkflow.AnyWithProps, text);
            }
            yield* run.value.step.sleep(`child-wait/${id}/${check}`, "5 seconds");
          }
        }) as Effect.Effect<any>,

      poll: (workflow, executionId) =>
        Effect.map(
          resultOf(
            handle,
            workflow as EffectWorkflow.AnyWithProps,
            nameOf(workflow._tag, executionId),
          ),
          (result) =>
            result === null
              ? Option.none()
              : Option.some(result ?? EffectWorkflow.Suspended.make({})),
        ),

      // The run wakes from whatever it waits for, fails there, and runs
      // its compensations.
      interrupt: (workflow, executionId) =>
        sendEvent(handle, nameOf(workflow._tag, executionId), { type: INTERRUPT }),

      interruptUnsafe: (workflow, executionId) =>
        inTransit(
          handle
            .get(nameOf(workflow._tag, executionId))
            .pipe(Effect.flatMap((instance) => instance.terminate())),
        ),

      // Only a run suspended on a failure waits to be resumed.
      resume: (workflow, executionId) =>
        sendEvent(handle, nameOf(workflow._tag, executionId), { type: RESUME }),

      activityExecute: (activity, attempt) =>
        Effect.gen(function* () {
          const run = yield* currentRun("activity execution");
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          // The step's exit, failure or not, is its result. A defect the
          // workflow doesn't capture fails the step instead, so Cloudflare
          // retries it, and is a defect again once retries run out. An
          // activity that suspends on a failure records that, and a resume
          // runs it again under a new step name.
          for (let generation = 0; ; generation++) {
            const text = yield* run.step
              .do({
                name:
                  generation === 0
                    ? `${activity.name}/${attempt}`
                    : `${activity.name}/${attempt}/resumed-${generation}`,
                effect: activity.executeEncoded.pipe(
                  EffectWorkflow.intoResult,
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterruptsOnly(cause),
                    (cause) =>
                      Effect.fail<ActivityDefect>({
                        _tag: "ActivityDefect",
                        message: Cause.pretty(cause),
                      }),
                  ),
                  Effect.flatMap((result) =>
                    result._tag === "Complete"
                      ? encodeExit(result.exit)
                      : Effect.succeed(SUSPENDED),
                  ),
                  // The run's services, with the step's own instance.
                  Effect.provide(
                    Layer.succeedContext(
                      run.context.pipe(
                        Context.add(WorkflowEngine.WorkflowInstance, activityInstance),
                        // The step runs on its own fiber: carry the attempt `Activity.retry` set.
                        Context.add(Activity.CurrentAttempt, attempt),
                        Context.add(
                          CurrentActivity,
                          makeCurrentActivity(
                            instance.workflow._tag,
                            instance.executionId,
                            activity.name,
                          ),
                        ),
                      ),
                    ),
                  ),
                ) as Effect.Effect<string, ActivityDefect>,
              })
              .pipe(
                Effect.catchTag("ActivityDefect", (defect) =>
                  Effect.die(new Error(defect.message)),
                ),
              );
            if (text !== SUSPENDED) {
              return new EffectWorkflow.Complete({ exit: yield* decodeExit(text) });
            }
            // Suspended on a failure: wait here for a resume, then run the
            // activity again, or for an interrupt.
            const waiting = `${activity.name}/${attempt}/suspended-${generation}`;
            const resumed = yield* run.step
              .waitForEvent(waiting, { type: RESUME, timeout: SIGNAL_TIMEOUT })
              .pipe(
                Effect.as(true),
                Effect.raceFirst(
                  run.step
                    .waitForEvent(`${waiting}/interrupt`, {
                      type: INTERRUPT,
                      timeout: SIGNAL_TIMEOUT,
                    })
                    .pipe(Effect.as(false)),
                ),
              );
            if (!resumed) {
              run.instance.interrupted = true;
              run.instance.suspended = false;
              return yield* Effect.interrupt;
            }
          }
        }),

      deferredResult: (deferred) =>
        Effect.gen(function* () {
          const run = yield* currentRun("DurableDeferred reads");
          // A race asks for its recorded winner before it runs. A step can only
          // be replayed by running it, so a winner can't be looked up first.
          if (deferred.name.startsWith("raceAll/")) {
            return yield* Effect.die(
              new Error(
                "Activity.raceAll and DurableDeferred.raceAll aren't supported on Cloudflare Workflows: a step's result can't be looked up before the step runs. Use the Durable Object engine.",
              ),
            );
          }
          const duration = run.clocks.get(deferred.name);
          // Every wait also waits for an interrupt.
          const interrupt = run.step
            .waitForEvent(`${deferred.name}/interrupt`, {
              type: INTERRUPT,
              timeout: SIGNAL_TIMEOUT,
            })
            .pipe(Effect.as({ interrupted: true, payload: "" }));
          const signal = yield* (
            duration !== undefined
              ? run.step
                  .sleep(deferred.name, Duration.toMillis(duration))
                  .pipe(Effect.as({ interrupted: false, payload: "" }))
              : run.step
                  .waitForEvent<string>(deferred.name, {
                    type: nameOf(deferred.name),
                    timeout: SIGNAL_TIMEOUT,
                  })
                  .pipe(Effect.map((event) => ({ interrupted: false, payload: event.payload })))
          ).pipe(Effect.raceFirst(interrupt));
          if (signal.interrupted) {
            run.instance.interrupted = true;
            run.instance.suspended = false;
            return yield* Effect.interrupt;
          }
          return Option.some(
            duration !== undefined ? Exit.void : yield* decodeExit(signal.payload),
          );
        }),

      deferredDone: (opts) =>
        Effect.gen(function* () {
          const payload = yield* encodeExit(opts.exit);
          yield* sendEvent(handle, nameOf(opts.workflowName, opts.executionId), {
            type: nameOf(opts.deferredName),
            payload,
          });
        }),

      scheduleClock: (_workflow, opts) =>
        Effect.flatMap(currentRun("DurableClock scheduling"), (run) =>
          Effect.sync(() => void run.clocks.set(opts.clock.deferred.name, opts.clock.duration)),
        ),
    });
    return engine;
  }),
);

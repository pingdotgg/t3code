import { makeCallback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  CurrentActivity,
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import { StorageName } from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { Workflow, WorkflowEngine } from "effect/workflow";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectJurisdiction,
} from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import type { Worker } from "../Workers/Worker.ts";

/**
 * Runs Effect workflows on Durable Objects. Each workflow gets its own Durable
 * Object class on the host Worker, and each execution is one instance of it,
 * named by its execution id, with its journal in that instance's SQLite.
 *
 * A run replays the workflow from the top: finished activities return their
 * stored results, and the first unfinished one runs and is stored. A run that
 * waits on a `DurableClock` or `DurableDeferred` that isn't ready suspends,
 * and the clock firing or the deferred being completed runs it again. Every
 * run happens in one durable callback per execution, so runs never overlap,
 * and a run that fails or is cut short is retried.
 *
 * ### Running workflows on Durable Objects
 * **Example:** Provide the engine to a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Schema from "effect/Schema";
 * import { Activity, Workflow } from "effect/workflow";
 *
 * const SendWelcome = Workflow.make("SendWelcome", {
 *   payload: { userId: Schema.String },
 *   idempotencyKey: ({ userId }) => userId,
 * });
 *
 * const SendWelcomeLive = Workflows.layer(
 *   SendWelcome,
 *   Effect.fn(function* ({ userId }) {
 *     yield* Activity.make({ name: "send", execute: Effect.log(`welcome, ${userId}`) });
 *   }),
 * );
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
 *     Effect.provide(
 *       SendWelcomeLive.pipe(
 *         Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine()),
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### Running executions in a jurisdiction
 * **Example:** Every execution in the EU
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Layer from "effect/Layer";
 * import { SendWelcomeLive } from "./SendWelcome.ts";
 *
 * const WorkflowsLive = SendWelcomeLive.pipe(
 *   Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine({ jurisdiction: "eu" })),
 * );
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Durable Objects
 */
export function layerDurableObjectEngine({
  jurisdiction,
}: DurableObjectEngineOptions = {}): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> {
  // The same options return the same Layer, so providing it in several places
  // builds one engine.
  let engine = engines.get(jurisdiction);
  if (engine === undefined) engines.set(jurisdiction, (engine = makeEngine(jurisdiction)));
  return engine;
}

/** Options for {@link layerDurableObjectEngine}. */
export interface DurableObjectEngineOptions {
  /**
   * Create and store every workflow execution object only inside this
   * jurisdiction, e.g. `"eu"`. An execution in a jurisdiction is a different
   * object from the one with the same name outside it, so setting this does
   * not move executions that already exist.
   *
   * Enforced when deployed, not emulated in `alchemy dev` (local workerd does
   * not implement jurisdictions).
   *
   * @default undefined (no jurisdiction restriction)
   */
  readonly jurisdiction?: DurableObjectJurisdiction;
}

const engines = new Map<
  DurableObjectJurisdiction | undefined,
  Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker>
>();

const makeEngine = (
  jurisdiction: DurableObjectJurisdiction | undefined,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      // Workflows register while their Layers build, inside the Worker's init
      // phase; declaring a Durable Object class needs that context.
      const init = yield* Effect.context<Worker>();
      const namespaces = new Map<string, Namespace>();

      const namespaceOf = (workflowName: string) =>
        Effect.suspend(() => {
          const namespace = namespaces.get(workflowName);
          return namespace
            ? Effect.succeed(namespace)
            : Effect.die(new Error(`Workflow ${workflowName} is not registered`));
        });
      const stubOf = (workflowName: string, executionId: string) =>
        Effect.map(namespaceOf(workflowName), (namespace) => namespace.getByName(executionId));

      const engine: WorkflowEngine.WorkflowEngine["Service"] = WorkflowEngine.makeUnsafe({
        register: (workflow, execute) =>
          Effect.gen(function* () {
            if (namespaces.has(workflow._tag)) return;
            const namespace = yield* declare(
              `${workflowClassName(workflow)}Workflow`,
              executionObject({ workflow: workflow as AnyWorkflow, execute, engine: () => engine }),
            ).pipe(Effect.provide(init));
            namespaces.set(
              workflow._tag,
              jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction),
            );
          }),

        execute: (workflow, options) =>
          Effect.gen(function* () {
            const payload = yield* Schema.encodeEffect(payloadCodec(workflow as AnyWorkflow))(
              options.payload,
            ).pipe(Effect.orDie);
            const parent: ParentRef | null = options.parent
              ? {
                  workflowName: options.parent.workflow._tag,
                  executionId: options.parent.executionId,
                }
              : null;
            const stub = yield* stubOf(workflow._tag, options.executionId);
            const result = yield* call<string | null>(
              stub.start(options.executionId, JSON.stringify(payload), JSON.stringify(parent)),
            );
            if (options.discard) return undefined;
            return result === null
              ? Workflow.Suspended.make({})
              : yield* decodeResult(workflow as AnyWorkflow, result);
          }) as Effect.Effect<any>,

        poll: (workflow, executionId) =>
          Effect.gen(function* () {
            const stub = yield* stubOf(workflow._tag, executionId);
            const polled = yield* call<{
              readonly started: boolean;
              readonly result: string | null;
            }>(stub.poll());
            if (!polled.started) return Option.none();
            if (polled.result === null) return Option.some(Workflow.Suspended.make({}));
            return Option.some(yield* decodeResult(workflow as AnyWorkflow, polled.result));
          }),

        interrupt: (workflow, executionId) =>
          Effect.flatMap(stubOf(workflow._tag, executionId), (stub) => call(stub.interrupt())),

        interruptUnsafe: (workflow, executionId) =>
          Effect.flatMap(stubOf(workflow._tag, executionId), (stub) =>
            call(stub.interruptUnsafe()),
          ),

        resume: (workflow, executionId) =>
          Effect.flatMap(stubOf(workflow._tag, executionId), (stub) => call(stub.resume())),

        // An activity's result is stored the first time it completes and
        // replayed on every run after that.
        activityExecute: (activity, attempt) =>
          Effect.gen(function* () {
            const execution = yield* currentExecution("activity execution");
            const instance = yield* WorkflowEngine.WorkflowInstance;
            const key = `${activity.name}/${attempt}`;
            const stored = yield* execution.query<{ exit: string }>(
              "SELECT exit FROM workflow_activity WHERE key = ?",
              key,
            );
            if (stored.length > 0) {
              return new Workflow.Complete({ exit: yield* decodeExit(stored[0]!.exit) });
            }
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
                    makeCurrentActivity(
                      instance.workflow._tag,
                      instance.executionId,
                      activity.name,
                    ),
                  ),
                ),
              ),
            );
            if (result._tag === "Complete") {
              yield* execution.query(
                "INSERT OR REPLACE INTO workflow_activity (key, exit) VALUES (?, ?)",
                key,
                yield* encodeExit(result.exit),
              );
            }
            return result;
          }),

        deferredResult: (deferred) =>
          Effect.gen(function* () {
            const execution = yield* currentExecution("DurableDeferred reads");
            const stored = yield* execution.query<{ exit: string }>(
              "SELECT exit FROM workflow_deferred WHERE name = ?",
              deferred.name,
            );
            if (stored.length === 0) return Option.none();
            return Option.some(yield* decodeExit(stored[0]!.exit));
          }),

        // Completing a deferred of the running execution writes locally;
        // anything else goes to the execution's Durable Object.
        deferredDone: (options) =>
          Effect.gen(function* () {
            const exit = yield* encodeExit(options.exit);
            const current = yield* Effect.serviceOption(CurrentExecution);
            if (
              Option.isSome(current) &&
              current.value.workflowName === options.workflowName &&
              current.value.executionId === options.executionId
            ) {
              return yield* current.value.complete(options.deferredName, exit);
            }
            const stub = yield* stubOf(options.workflowName, options.executionId);
            yield* call(stub.deferredDone(options.deferredName, exit));
          }),

        // A clock keeps the due time it was first given, however many times
        // the run replays past `DurableClock.sleep`.
        scheduleClock: (_workflow, options) =>
          Effect.gen(function* () {
            const execution = yield* currentExecution("DurableClock scheduling");
            const now = yield* Clock.currentTimeMillis;
            yield* execution.query(
              "INSERT OR IGNORE INTO workflow_clock (name, deferred, due) VALUES (?, ?, ?)",
              options.clock.name,
              options.clock.deferred.name,
              now + Duration.toMillis(options.clock.duration),
            );
            const [clock] = yield* execution.query<{ due: number }>(
              "SELECT due FROM workflow_clock WHERE name = ?",
              options.clock.name,
            );
            yield* execution.scheduleClock(
              options.clock.name,
              options.clock.deferred.name,
              clock!.due,
            );
          }),
      });

      return engine;
    }),
  );

// ---------------------------------------------------------------- the execution object

type AnyWorkflow = Workflow.AnyWithProps;

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

interface Registration {
  readonly workflow: AnyWorkflow;
  readonly execute: Execute;
  readonly engine: () => WorkflowEngine.WorkflowEngine["Service"];
}

interface ParentRef {
  readonly workflowName: string;
  readonly executionId: string;
}

/**
 * The execution a run belongs to. The engine's in-run operations (activities,
 * deferreds, clocks) read and write its journal through this.
 */
class CurrentExecution extends Context.Service<
  CurrentExecution,
  {
    readonly workflowName: string;
    readonly executionId: string;
    readonly query: <T extends Record<string, string | number | null>>(
      sql: string,
      ...bindings: ReadonlyArray<unknown>
    ) => Effect.Effect<ReadonlyArray<T>>;
    readonly complete: (deferredName: string, exit: string) => Effect.Effect<void>;
    readonly scheduleClock: (
      name: string,
      deferredName: string,
      due: number,
    ) => Effect.Effect<void>;
  }
>()("alchemy/Cloudflare/Workflows/DurableObjectEngine/CurrentExecution") {}

const currentExecution = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentExecution), (current) =>
    Option.isSome(current)
      ? Effect.succeed(current.value)
      : Effect.die(
          new Error(`DurableObjectEngine: ${operation} only runs inside a workflow execution`),
        ),
  );

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_execution (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  execution_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  parent TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  result TEXT
);
CREATE TABLE IF NOT EXISTS workflow_activity (key TEXT PRIMARY KEY, exit TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_deferred (name TEXT PRIMARY KEY, exit TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_clock (
  name TEXT PRIMARY KEY,
  deferred TEXT NOT NULL,
  due INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL
);
`;

interface ExecutionRow {
  readonly execution_id: string;
  readonly payload: string;
  readonly parent: string | null;
  readonly interrupted: number;
  readonly result: string | null;
  readonly [column: string]: string | number | null;
}

/** The single job id every wake-up schedules, so pending wake-ups collapse into one run. */
const RUN = "run";

/** One workflow execution: its journal, and the runs that replay it. */
const executionObject = (registration: Registration) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const context = yield* Effect.context<RuntimeContext>();
      const query = <T extends Record<string, string | number | null>>(
        sql: string,
        ...bindings: ReadonlyArray<unknown>
      ): Effect.Effect<ReadonlyArray<T>> =>
        state.storage.sql.exec<T>(sql, ...bindings).pipe(
          Effect.flatMap((cursor) => cursor.toArray()),
          Effect.provide(context),
        );
      yield* query(SCHEMA);

      const readExecution = Effect.map(
        query<ExecutionRow>("SELECT * FROM workflow_execution"),
        (rows) => rows[0],
      );

      // A wake-up scheduled from inside a callback inherits that callback's
      // retry budget unless it reports progress. Each new journal entry that
      // schedules a wake-up advances this cursor in the same transaction, so a
      // wake-up after a successful step runs on time instead of waiting out a
      // backoff.
      const advance = Effect.map(
        query<{ seq: number }>(
          "INSERT INTO workflow_progress (id, seq) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET seq = seq + 1 RETURNING seq",
        ),
        (rows) => rows[0]!.seq,
      );
      const transaction = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
        state.storage.transaction(effect).pipe(Effect.orDie, Effect.provide(context));

      // Every wake-up (a start, a completed deferred, a fired clock, an
      // interrupt) records what changed and schedules this one job. Jobs run
      // one at a time and are retried until a run succeeds.
      const runs = yield* makeCallback(RUN, () => run, { retry: { delay: "5 seconds" } });
      const wake = (progress?: number) =>
        runs
          .schedule(RUN, { after: 0, payload: {}, progress })
          .pipe(Effect.orDie, Effect.provide(context));

      const complete = (deferredName: string, exit: string) =>
        transaction(
          Effect.gen(function* () {
            const inserted = yield* query(
              "INSERT OR IGNORE INTO workflow_deferred (name, exit) VALUES (?, ?) RETURNING name",
              deferredName,
              exit,
            );
            if (inserted.length > 0) return yield* wake(yield* advance);
            // Completed already, and that completion woke the run. Replacing a
            // pending wake-up here would hand it this caller's retry budget.
            const pending = yield* runs.getStatus(RUN).pipe(Effect.orDie);
            if (pending === undefined) yield* wake();
          }),
        );

      const clocks = yield* makeCallback(
        "clock",
        (job: { readonly deferred: string }) =>
          Effect.gen(function* () {
            yield* complete(job.deferred, yield* encodeExit(Exit.void));
          }),
        { retry: { delay: "5 seconds" } },
      );
      // Replays reach the same sleep again: a clock that's done or already
      // pending is left alone.
      const scheduleClock = (name: string, deferredName: string, due: number) =>
        transaction(
          Effect.gen(function* () {
            const done = yield* query(
              "SELECT 1 FROM workflow_deferred WHERE name = ?",
              deferredName,
            );
            if (done.length > 0) return;
            if ((yield* clocks.getStatus(name).pipe(Effect.orDie)) !== undefined) return;
            yield* clocks
              .schedule(name, {
                at: due,
                payload: { deferred: deferredName },
                progress: yield* advance,
              })
              .pipe(Effect.orDie);
          }),
        );

      const run: Effect.Effect<void> = Effect.gen(function* () {
        const row = yield* readExecution;
        if (row === undefined || row.result !== null) return;
        const { workflow, execute } = registration;
        const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(
          JSON.parse(row.payload),
        ).pipe(Effect.orDie);
        const instance = WorkflowEngine.WorkflowInstance.initial(workflow, row.execution_id);
        const result = yield* execute(payload as object, row.execution_id).pipe(
          // An interrupted execution replays to where it waits, then is
          // interrupted there, which fails it and runs its compensations.
          Effect.onExit(() => {
            if (row.interrupted !== 1) return Effect.void;
            instance.interrupted = true;
            instance.suspended = false;
            return Effect.withFiber((fiber) => fiber.pipe(Fiber.interrupt, Effect.interruptible));
          }),
          Workflow.intoResult,
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
              Layer.succeed(WorkflowEngine.WorkflowEngine, registration.engine()),
              Layer.succeed(CurrentExecution, {
                workflowName: workflow._tag,
                executionId: row.execution_id,
                query,
                complete,
                scheduleClock,
              }),
            ),
          ),
        );
        // Suspended: a clock or a completed deferred wakes it again.
        if (result._tag === "Suspended") return;
        yield* query(
          "UPDATE workflow_execution SET result = ?",
          yield* encodeResult(workflow, result.exit),
        );
        if (row.parent !== null) yield* resumeParent(registration, JSON.parse(row.parent));
      });

      const result = Effect.map(readExecution, (row) => row?.result ?? null);

      return {
        /** Create the execution if it's new, and return its result once it has one. */
        start: (executionId: string, payload: string, parent: string) =>
          reportDefects(
            Effect.gen(function* () {
              const existing = yield* readExecution;
              if (existing === undefined) {
                yield* query(
                  "INSERT INTO workflow_execution (id, execution_id, payload, parent) VALUES (1, ?, ?, ?)",
                  executionId,
                  payload,
                  parent === "null" ? null : parent,
                );
                yield* wake();
              }
              return yield* result;
            }),
          ),
        poll: () =>
          reportDefects(
            Effect.map(readExecution, (row) => ({
              started: row !== undefined,
              result: row?.result ?? null,
            })),
          ),
        deferredDone: (deferredName: string, exit: string) =>
          reportDefects(complete(deferredName, exit)),
        resume: () => reportDefects(wake()),
        // The next run replays with the instance marked interrupted, which
        // fails the workflow and runs its compensations.
        interrupt: () =>
          reportDefects(
            query("UPDATE workflow_execution SET interrupted = 1").pipe(Effect.andThen(wake())),
          ),
        // Stop without running compensations.
        interruptUnsafe: () =>
          reportDefects(
            Effect.gen(function* () {
              yield* runs.cancel(RUN).pipe(Effect.orDie, Effect.provide(context));
              yield* query(
                "UPDATE workflow_execution SET interrupted = 1, result = ? WHERE result IS NULL",
                yield* encodeResult(registration.workflow, Exit.interrupt()),
              );
            }),
          ),
      };
    });
  });

/** A child execution finished: its parent replays and reads the child's result. */
const resumeParent = (registration: Registration, parent: ParentRef) =>
  Effect.gen(function* () {
    const engine = registration.engine();
    yield* engine.resume({ _tag: parent.workflowName } as Workflow.Any, parent.executionId);
  });

// ---------------------------------------------------------------- Durable Object calls

const DefectTag = "alchemy/Cloudflare/Workflows/DurableObjectEngine/Defect";

/**
 * Workers RPC replaces thrown errors with an opaque "internal error". Return
 * failures as data instead, and rethrow them as defects on the calling side.
 */
const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/**
 * Call an execution's Durable Object. Every method is idempotent, so a call
 * that fails in transit (an instance resetting, or still running the previous
 * script during a deploy) is retried for about a minute.
 */
const call = <A = void>(effect: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
      times: 35,
    }),
    Effect.orDie,
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

interface Namespace {
  readonly getByName: (name: string) => Stub;
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => Namespace;
}

type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, DurableObjectState | RuntimeContext | Scope.Scope>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker. The inline form of
 * `Cloudflare.DurableObject` is typed for single-stage implementations, so it
 * is re-typed here for the two-stage form it runs.
 */
/**
 * The class name a workflow's runs are stored under: its `StorageName`, which
 * may be dotted like a Domain model's `Billing.OpenAccount`, or else its name.
 */
const workflowClassName = (workflow: Workflow.Any) => {
  const storageName = Context.getOrUndefined(workflow.annotations, StorageName);
  return storageName === undefined
    ? workflow._tag.replace(/[^A-Za-z0-9_]/g, "_")
    : storageName.replace(/[^A-Za-z0-9_.]/g, "_");
};

const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

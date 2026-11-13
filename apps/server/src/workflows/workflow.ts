// The author-facing primitives. A workflow body is replayed after a restart, so anything that
// touches the world goes through `step`; these are all a body may use.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";

import { checkOutput } from "../orchestration-v2/runOutput.ts";
import { EngineLink, forStep, type InStep, KeyValues, Runs } from "./stepServices.ts";
import type { ScheduleTrigger, Trigger, WebhookTrigger } from "./triggers.ts";
import type { WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

/** A step that could not be completed. Its run is paused until someone resumes it. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.step}: ${this.reason}`;
  }
}

/** The workflow's own decision to end without a result. */
export class WorkflowStop extends Schema.TaggedError<WorkflowStop>()("WorkflowStop", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** What the primitives need from the run they are called in. */
export class RunContext extends Context.Service<
  RunContext,
  {
    readonly runId: string;
    readonly workflow: string;
    readonly store: WorkflowStore.WorkflowStore["Service"];
    /** Names used so far in this pass over the body: two steps with one name would share a result. */
    readonly names: Set<string>;
    /** What the code of the step `name` may use. */
    readonly forStep: (name: string) => Context.Context<InStep>;
  }
>()("t3/workflows/workflow/RunContext") {}

/** What a workflow body may require: the run it is in, the engine, and somewhere to run agents. */
export type InRun =
  | RunContext
  | WorkflowAgents
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance;

/** Takes `name` for one step of the run. Step results and the step list are both kept by name. */
export const claim = (name: string) =>
  Effect.flatMap(RunContext, (run) => {
    if (run.names.has(name)) {
      return Effect.die(
        new Error(
          `Two steps in workflow ${run.workflow} are named "${name}". Names are unique in a run.`,
        ),
      );
    }
    run.names.add(name);
    return Effect.succeed(run);
  });

/** An error as one line for a person, with what caused it when the error only wraps something. */
export const text = (error: unknown): string => {
  if (typeof error === "string") return error.slice(0, 2000);
  if (typeof error !== "object" || error === null) return String(error);
  // Also an error that came back from the journal, which is its fields and no longer an Error.
  const fields = error as {
    readonly message?: unknown;
    readonly reason?: unknown;
    cause?: unknown;
  };
  const message =
    typeof fields.message === "string" && fields.message !== ""
      ? fields.message
      : typeof fields.reason === "string"
        ? fields.reason
        : "Unknown error";
  return (fields.cause === undefined ? message : `${message}: ${text(fields.cause)}`).slice(
    0,
    2000,
  );
};

/**
 * One journaled action of the step `name`: it happens once, and a replay returns what it stored.
 * A failure marks the step failed and pauses the run here; resuming the run executes it again.
 */
export const journaled = <A, I, E>(
  run: RunContext["Service"],
  name: string,
  action: string,
  returns: Schema.Codec<A, I>,
  execute: Effect.Effect<A, E>,
) => {
  const codec = Schema.toCodecJson(returns);
  const encodable = Schema.encodeEffect(codec);
  return Activity.make({
    name: action,
    success: returns,
    error: StepFailed,
    execute: execute.pipe(
      // A result the journal cannot store is this step's failure, found before it is journaled.
      Effect.tap(encodable),
      // The engine reads its own 64-bit ids as BigInt. What a step calls must not inherit that.
      Effect.provideService(SqlClient.SafeIntegers, false),
      // Also a step that dies: left as a defect the engine would park the run without a word.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(new StepFailed({ step: name, reason: text(Cause.squash(cause)) })),
      ),
      Effect.tapError((error) =>
        Effect.andThen(
          run.store.stepEnded(run.runId, name, "failed", error.reason),
          run.store.runPaused(run.runId, error.message),
        ),
      ),
    ),
  });
};

/** How an invoked run ended, as its parent's wait receives it. */
export const ChildEnd = Schema.Struct({
  outcome: Schema.Literals(["completed", "stopped", "cancelled"]),
  value: Schema.Json,
  reason: Schema.optional(Schema.String),
});

export interface StepRetry {
  /** How many more times to try before the run is paused. */
  readonly times: number;
  readonly schedule?: Schedule.Schedule<unknown, unknown>;
}
const DEFAULT_RETRY: StepRetry = { times: 3, schedule: Schedule.exponential("2 seconds") };

/**
 * Do something once per run. The result is stored, and a replay returns the stored result.
 *
 * A failure is retried by `retry`, then pauses the run at this step: resuming the run runs the step
 * again. A step that wants its workflow to decide about a failure returns it as data.
 */
export const step = <A, I, E>(
  name: string,
  options: { readonly returns: Schema.Codec<A, I>; readonly retry?: StepRetry },
  code: Effect.Effect<A, E, InStep>,
): Effect.Effect<A, StepFailed, InRun> =>
  Effect.flatMap(claim(name), (run) => {
    const retry = options.retry ?? DEFAULT_RETRY;
    const resultCodec = Schema.toCodecJson(options.returns);
    const encodeResult = Schema.encodeEffect(resultCodec);
    // Made per try, so a retry numbers its signals from the start again.
    const execute = Effect.suspend(() => Effect.provideContext(code, run.forStep(name)));
    return journaled(
      run,
      name,
      `step/${name}`,
      options.returns,
      run.store.stepStarted(run.runId, name, "step").pipe(
        Effect.andThen(
          retry.times === 0
            ? execute
            : Effect.retry(execute, {
                times: retry.times,
                ...(retry.schedule === undefined ? {} : { schedule: retry.schedule }),
              }),
        ),
        Effect.tap(() => run.store.stepEnded(run.runId, name, "completed", null)),
        // For a person reading the run. A value that does not encode fails the step just after.
        Effect.tap((value) =>
          Effect.ignore(
            Effect.flatMap(encodeResult(value), (json) =>
              run.store.stepResult(run.runId, name, json as Schema.Json),
            ),
          ),
        ),
      ),
    );
  });

/** A sleep that survives a restart. */
export const sleep = Effect.fn("workflow.sleep")(function* (
  name: string,
  duration: Duration.Input,
): Effect.fn.Return<void, never, InRun> {
  const run = yield* claim(name);
  // Listed like any step, with when it wakes, so a run that sleeps for days says so.
  yield* Activity.make({
    name: `sleep/${name}/open`,
    execute: Effect.gen(function* () {
      const wakes = DateTime.addDuration(yield* DateTime.now, Duration.fromInputUnsafe(duration));
      yield* run.store.stepStarted(run.runId, name, "sleep");
      yield* run.store.stepDetail(run.runId, name, DateTime.formatIso(wakes));
      yield* run.store.runStatus(run.runId, "waiting", `sleep ${name}`);
    }),
  });
  yield* DurableClock.sleep({ name: `sleep/${name}`, duration });
  yield* Activity.make({
    name: `sleep/${name}/close`,
    execute: Effect.andThen(
      run.store.stepEnded(run.runId, name, "completed", null),
      run.store.runResumed(run.runId),
    ),
  });
});

export const Woke = Schema.Struct({ expired: Schema.Boolean, value: Schema.Json });
export const wakeOf = (name: string) => DurableDeferred.make(`wait/${name}`, { success: Woke });
export const jsonSchemaOf = (schema: Schema.Top): Record<string, Schema.Json> => {
  const document = Schema.toJsonSchemaDocument(schema);
  return { ...document.schema, $defs: document.definitions } as Record<string, Schema.Json>;
};

/** `wait`, also as the question a person answers: `request` is what an inbox shows them. */
export const waitAs = Effect.fn("workflow.wait")(function* <A, I>(
  kind: "wait" | "ask",
  name: string,
  options: {
    readonly returns: Schema.Codec<A, I>;
    readonly timeout?: Duration.Input | undefined;
    readonly key?: string | undefined;
    readonly request?: Schema.Json | undefined;
  },
): Effect.fn.Return<Option.Option<A>, StepFailed, InRun> {
  const run = yield* claim(name);
  const wake = wakeOf(name);
  const token = yield* DurableDeferred.token(wake);
  const here: WorkflowStore.SignalAddress = { runId: run.runId, wait: name };
  const schema = jsonSchemaOf(options.returns);
  yield* Activity.make({
    name: `wait/${name}/open`,
    execute: Effect.gen(function* () {
      const deadline =
        options.timeout === undefined
          ? null
          : DateTime.formatIso(
              DateTime.addDuration(yield* DateTime.now, Duration.fromInputUnsafe(options.timeout)),
            );
      yield* run.store.stepStarted(run.runId, name, kind);
      yield* run.store.waitOpened({
        runId: run.runId,
        name,
        workflow: run.workflow,
        key: options.key,
        token,
        schemaJson: WorkflowStore.jsonText(schema),
        requestJson: options.request === undefined ? null : WorkflowStore.jsonText(options.request),
        deadline,
      });
      yield* run.store.runStatus(run.runId, "waiting", name);
      // Whatever arrived early is delivered now, checked as a signal to an open wait is. The mail
      // goes only after the wake: waking twice is harmless, and losing the signal is not.
      const addresses: ReadonlyArray<WorkflowStore.SignalAddress> =
        options.key === undefined ? [here] : [here, { workflow: run.workflow, key: options.key }];
      while (true) {
        const early = yield* run.store.mailNext(addresses);
        if (early === undefined) break;
        const checked = yield* checkOutput(schema, early.valueJson);
        if (Result.isSuccess(checked)) {
          yield* run.store.waitSignalled(run.runId, name);
          yield* run.store.signalDelivered(early.signalId);
          yield* DurableDeferred.succeed(wake, {
            token,
            value: { expired: false, value: checked.success },
          });
        }
        yield* run.store.mailDelete(early.signalId);
        if (Result.isSuccess(checked)) break;
      }
    }),
  });
  const woke = yield* DurableDeferred.await(wake);
  yield* Activity.make({
    name: `wait/${name}/close`,
    execute: Effect.gen(function* () {
      yield* run.store.waitClosed(run.runId, name);
      yield* run.store.stepEnded(run.runId, name, "completed", woke.expired ? "timed out" : null);
      if (!woke.expired) yield* run.store.stepResult(run.runId, name, woke.value);
      yield* run.store.runResumed(run.runId);
    }),
  });
  if (woke.expired) return Option.none();
  // Checked against this schema when it was signalled, so a mismatch here is a changed schema.
  const codec = Schema.toCodecJson(options.returns);
  const decode = Schema.decodeEffect(codec);
  const value = yield* decode(woke.value).pipe(
    Effect.mapError((error) => new StepFailed({ step: name, reason: text(error) })),
  );
  return Option.some(value);
});

/**
 * Sleep until something outside signals this wait; `None` when the timeout passes first.
 * Addressed by run and wait name, or by `key` (scoped to the workflow's name) when the sender
 * cannot know the run. A signal sent before the wait opened is delivered when it opens.
 */
export const wait = <A, I>(
  name: string,
  options: {
    readonly returns: Schema.Codec<A, I>;
    readonly timeout?: Duration.Input;
    readonly key?: string;
  },
) => waitAs("wait", name, options);

/** End the run by the workflow's own decision. It ends as `stopped`, which is not a failure. */
export const stop = (reason: string): Effect.Effect<never, WorkflowStop> =>
  Effect.fail(new WorkflowStop({ reason }));

/** Name the run in lists. Defaults to the workflow's name and the run's key. */
export const title = (name: string, value: string): Effect.Effect<void, StepFailed, InRun> =>
  Effect.flatMap(claim(name), (run) =>
    Activity.make({
      name: `title/${name}`,
      execute: run.store.runTitle(run.runId, value),
    }),
  );

// The defaults are every workflow: a registry holds workflows of every payload and result type.
export interface WorkflowDefinition<P = never, A = unknown> {
  /** Types only: what a run is started with and what it returns, for `start` and `invoke`. */
  readonly "~types"?: { readonly payload: (payload: P) => void; readonly returns: A };
  readonly name: string;
  readonly version: number;
  readonly payload: Schema.Codec<unknown, unknown>;
  readonly returns: Schema.Codec<unknown, unknown>;
  /** How long a paused run rests before it is resumed by itself, per pause in a row. */
  readonly resumeAfter: ReadonlyArray<Duration.Input>;
  readonly triggers: ReadonlyArray<ScheduleTrigger | WebhookTrigger>;
  /** Fails with the reason as text: by here nothing reads the error but a person. */
  readonly onEnd:
    | ((payload: never, end: RunEnd) => Effect.Effect<void, string, InStep>)
    | undefined;
  // The registry holds workflows of every payload type; `workflow` is where the types are checked.
  readonly body: (
    payload: never,
    run: { readonly id: string },
  ) => Effect.Effect<unknown, StepFailed | WorkflowStop, InRun>;
}

/** How a run ended, as its `onEnd` is told. A paused run has not ended. */
export interface RunEnd {
  readonly id: string;
  readonly outcome: "completed" | "stopped" | "cancelled";
  readonly reason: string | undefined;
}

/**
 * Run another workflow as part of this one and wait for how it ends. The other run is a run of
 * its own, listed and resumable by itself; cancelling this run cancels it. A run that paused has
 * not ended, so this waits on while someone resumes it.
 */
export const invoke = Effect.fn("workflow.invoke")(function* <P, A>(
  name: string,
  workflow: WorkflowDefinition<P, A>,
  payload: P,
  options?: { readonly key?: string },
): Effect.fn.Return<
  | { readonly outcome: "completed"; readonly value: A }
  | { readonly outcome: "stopped" | "cancelled"; readonly reason: string },
  StepFailed,
  InRun
> {
  const run = yield* RunContext;
  yield* step(
    `${name}/start`,
    { returns: Schema.String },
    Effect.flatMap(Runs, (runs) =>
      runs.start(workflow.name, payload, {
        idempotencyKey: options?.key ?? `${run.runId}/${name}`,
        parent: { runId: run.runId, wait: name },
      }),
    ).pipe(Effect.map((started) => started.runId)),
  );
  const ended = yield* waitAs("wait", name, { returns: ChildEnd });
  if (Option.isNone(ended)) {
    return yield* new StepFailed({ step: name, reason: "the wait ended without an outcome" });
  }
  if (ended.value.outcome !== "completed") {
    return { outcome: ended.value.outcome, reason: ended.value.reason ?? "" };
  }
  const returnsCodec = Schema.toCodecJson(workflow.returns);
  const decode = Schema.decodeEffect(returnsCodec);
  const value = yield* decode(ended.value.value).pipe(
    Effect.mapError((error) => new StepFailed({ step: name, reason: text(error) })),
  );
  return { outcome: "completed", value: value as A };
});

/** The step `onEnd` runs as. */
export const END_STEP = "onEnd";

const DEFAULT_RESUME_AFTER: ReadonlyArray<Duration.Input> = [
  "5 minutes",
  "20 minutes",
  "80 minutes",
];

/**
 * A workflow: a name, a version, and a body.
 *
 * A run keeps the version it started with. To change the order of steps or the shape of a stored
 * result, register the new body under a higher version and keep the old one registered until its
 * runs have ended.
 */
export const workflow = <P, PI, A = void, AI = void, EndError = never>(
  name: string,
  options: {
    readonly version: number;
    readonly payload: Schema.Codec<P, PI>;
    readonly returns?: Schema.Codec<A, AI>;
    readonly resumeAfter?: ReadonlyArray<Duration.Input>;
    /** What starts a run by itself. Each must give what `payload` takes. */
    readonly triggers?: ReadonlyArray<Trigger<P>>;
    /**
     * Runs once when the run ends, however it ends, to give back what the run took: a machine, a
     * lock. It gets the payload and the run's id, not the body's values, so name what the run
     * takes after its id. It must be safe to run for a run that took nothing.
     */
    readonly onEnd?: (payload: P, end: RunEnd) => Effect.Effect<unknown, EndError, InStep>;
  },
  body: (
    payload: P,
    run: { readonly id: string },
  ) => Effect.Effect<A, StepFailed | WorkflowStop, InRun>,
): WorkflowDefinition<P, A> => ({
  name,
  version: options.version,
  // Erased here, once: the registry holds workflows of every payload and result type.
  payload: options.payload as Schema.Codec<unknown, unknown>,
  // Without a schema the result is whatever JSON the body returned: dropping it would be a
  // surprise, and a value that is not JSON pauses the run with the reason.
  returns: (options.returns ?? Schema.UndefinedOr(Schema.Json)) as Schema.Codec<unknown, unknown>,
  resumeAfter: options.resumeAfter ?? DEFAULT_RESUME_AFTER,
  triggers: options.triggers ?? [],
  onEnd:
    options.onEnd === undefined
      ? undefined
      : (payload, end) => options.onEnd!(payload, end).pipe(Effect.asVoid, Effect.mapError(text)),
  body,
});

export const engineTag = (definition: Pick<WorkflowDefinition, "name" | "version">) =>
  `${definition.name}@${definition.version}`;

const Outcome = Schema.Struct({
  outcome: Schema.Literals(["completed", "stopped"]),
  value: Schema.Json,
  reason: Schema.optional(Schema.String),
});

export const engineWorkflow = (definition: WorkflowDefinition) =>
  Workflow.make(engineTag(definition), {
    payload: { idempotencyKey: Schema.String, input: Schema.Json },
    idempotencyKey: (payload) => payload.idempotencyKey,
    success: Outcome,
    error: Schema.Union([StepFailed, WorkflowStop]),
    // A failure parks the run instead of ending it; only an explicit resume wakes it.
  }).annotate(Workflow.SuspendOnFailure, true);
export type EngineWorkflow = ReturnType<typeof engineWorkflow>;

export const layerDefinition = (definition: WorkflowDefinition, engine: EngineWorkflow) => {
  const payloadCodec = Schema.toCodecJson(definition.payload);
  const decodePayload = Schema.decodeEffect(payloadCodec);
  const returnsCodec = Schema.toCodecJson(definition.returns);
  const encodeResult = Schema.encodeUnknownEffect(returnsCodec);
  return engine.toLayer((payload, runId) =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const keyValues = yield* KeyValues;
      const link = yield* EngineLink;
      yield* Activity.make({
        name: "run/begin",
        execute: store.runStarted({
          runId,
          workflow: definition.name,
          version: definition.version,
          engineTag: engineTag(definition),
          idempotencyKey: payload.idempotencyKey,
          input: payload.input,
        }),
      });
      const input = (yield* Effect.orDie(decodePayload(payload.input))) as never;
      const outcome = yield* definition.body(input, { id: runId }).pipe(
        Effect.flatMap((value) => Effect.orDie(encodeResult(value))),
        Effect.map((value): typeof Outcome.Type => ({
          outcome: "completed",
          value: (value ?? null) as Schema.Json,
        })),
        Effect.catchTags({
          WorkflowStop: (stopped) =>
            Effect.succeed<typeof Outcome.Type>({
              outcome: "stopped",
              value: null,
              reason: stopped.reason,
            }),
        }),
        // A step like any other: a cleanup that fails pauses the run, and resuming tries it again.
        Effect.tap((ended) =>
          definition.onEnd === undefined
            ? Effect.void
            : step(
                END_STEP,
                { returns: Schema.Void },
                definition.onEnd(input, {
                  id: runId,
                  outcome: ended.outcome,
                  reason: ended.reason,
                }),
              ),
        ),
        Effect.provideService(
          RunContext,
          RunContext.of({
            runId,
            workflow: definition.name,
            store,
            names: new Set(),
            forStep: (name) => forStep(keyValues, link, `${runId}/${name}`),
          }),
        ),
      );
      yield* Activity.make({
        name: "run/end",
        execute: store.runEnded(runId, outcome.outcome, outcome.reason ?? null, outcome.value),
      });
      yield* Activity.make({
        name: "run/told",
        execute: Effect.suspend(() => link.current?.ended(runId) ?? Effect.void),
      });
      return outcome;
    }).pipe(
      // A failing step marked the run paused itself. What reaches here otherwise is the body
      // breaking outside a step: a duplicate name, a payload that no longer decodes.
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.flatMap(WorkflowStore.WorkflowStore, (store) =>
              store.runPaused(runId, text(Cause.squash(cause))),
            ),
      ),
    ),
  );
};

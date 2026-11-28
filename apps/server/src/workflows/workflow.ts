// The author-facing primitives. A workflow body is replayed after a restart, so anything that
// touches the world goes through `step`; these are all a body may use.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SqlClient from "effect/sql/SqlClient";
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";

import { checkOptions, durationOf } from "./options.ts";
import {
  EngineLink,
  forStep,
  type InFlight,
  type InStep,
  KeyValues,
  Runs,
} from "./stepServices.ts";
import {
  checkTriggers,
  type OpenedTrigger,
  type ScheduleTrigger,
  type Trigger,
  type WebhookTrigger,
} from "./triggers.ts";
import type { WorkflowAgents } from "./WorkflowAgents.ts";
import {
  type SubjectInput,
  subjectReference,
  unavailable,
  WorkflowForge,
} from "./WorkflowForge.ts";
import { subjectSet } from "./runReferences.ts";
import * as WorkflowStore from "./WorkflowStore.ts";
import { withoutRoutineSpans } from "@t3tools/shared/observability";

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
  /** The run was never for this workflow to do, which lists leave out. */
  skipped: Schema.optional(Schema.Boolean),
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
    /** The steps running now, which a cancelled run's cleanup waits for. */
    readonly inFlight: InFlight;
    /** Have the engine see the agent turn behind the open wait `wait` through, and wake it. */
    readonly watchTurn: (wait: string) => Effect.Effect<void>;
    /** Queue the wait `name` for a place in `pool`, which wakes it once it has one. */
    readonly placeAsked: (name: string, pool: string, size: number) => Effect.Effect<void>;
    readonly placeLeft: (name: string) => Effect.Effect<void>;
    /** Hands out the places a pause gave back. */
    readonly placesFreed: Effect.Effect<void>;
  }
>()("t3/workflows/workflow/RunContext") {}

/** What a workflow body may require: the run it is in, the engine, and somewhere to run agents. */
export type InRun =
  | RunContext
  | WorkflowAgents
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance;

/** Takes `name` for one step of the run. Step results and the step list are both kept by name. */
export const claim = (name: string, internal = false) =>
  Effect.flatMap(RunContext, (run) => {
    // The cleanup step's name is its own, or a body step would take it and cleanup never run.
    if (name === END_STEP && !internal) {
      return Effect.die(
        new Error(
          `"${END_STEP}" is the name of workflow ${run.workflow}'s cleanup step. Name this step something else.`,
        ),
      );
    }
    // Nor can a body step take the name a pool queues at, whatever the pool is called.
    if (name.startsWith(PLACE_PREFIX) && !internal) {
      return Effect.die(
        new Error(
          `Names starting with "${PLACE_PREFIX}" are kept for the steps that queue for a place in a pool. Name "${name}" in workflow ${run.workflow} something else.`,
        ),
      );
    }
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
  if (typeof error === "string") return WorkflowStore.detailCut(error);
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
  return WorkflowStore.detailCut(
    fields.cause === undefined ? message : `${message}: ${text(fields.cause)}`,
  );
};

// What a workflow without `returns` returns: any JSON value, or nothing.
const ANY_JSON = Schema.UndefinedOr(Schema.Json);

/** Where in `value` JSON cannot hold what it finds, with `undefined` counted only when `strict`. */
const notJson = (value: unknown, at: string, strict: boolean): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${at} is ${value}`;
  if (value === undefined) return strict ? `${at} is undefined` : undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = notJson(item, `${at}[${index}]`, strict);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    return `${at} is ${typeof value === "object" ? (proto?.constructor?.name ?? "an object") : `a ${typeof value}`}`;
  }
  for (const [key, field] of Object.entries(value as object)) {
    const found = notJson(field, `${at}.${key}`, strict);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A value that did not encode, said with where JSON could not hold it, which `Schema.Json` omits. */
const encodeFailure = (what: string, error: unknown, value: unknown) => {
  const where = notJson(value, what, true);
  return where === undefined ? text(error) : `${text(error)}: ${where}`;
};

/** A step result the journal cannot store, which fails the step it came from. */
const unstorable = (error: unknown, value: unknown) =>
  Effect.die(new Error(encodeFailure("the result", error, value)));

/** What a run without `returns` returns, read as `JSON.stringify` reads it. */
const untypedResult = (value: unknown): Effect.Effect<Schema.Json> => {
  const where = notJson(value, "the run's result", false);
  if (where !== undefined) return Effect.die(new Error(`The run's result is not JSON: ${where}.`));
  return Effect.succeed(
    value === undefined ? null : (JSON.parse(JSON.stringify(value)) as Schema.Json),
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
  // The run waits for a person after this fails, not for `resumeAfter`.
  held = false,
) => {
  const codec = Schema.toCodecJson(returns);
  const encodable = Schema.encodeEffect(codec);
  // A wake can preempt the run while a failed step is still finishing, and the engine then
  // replays the paused run and runs the step again. Only a resume, which unpauses first, may.
  const unlessPaused = Effect.flatMap(run.store.run(run.runId), (row) =>
    row?.status === "paused"
      ? Effect.fail(new StepFailed({ step: name, reason: "The run is paused." }))
      : Effect.void,
  );
  return Activity.make({
    name: action,
    success: returns,
    error: StepFailed,
    execute: run.inFlight.track(run.runId, execute).pipe(
      // A result the journal cannot store is this step's failure, found before it is journaled.
      Effect.tap((value) => Effect.catch(encodable(value), (error) => unstorable(error, value))),
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
          Effect.andThen(run.store.runPaused(run.runId, error.message, held), run.placesFreed),
        ),
      ),
      (attempt) => Effect.andThen(unlessPaused, attempt),
    ),
  });
};

/** How an invoked run ended, as its parent's wait receives it. */
export const ChildEnd = Schema.Struct({
  outcome: Schema.Literals(["completed", "stopped", "skipped", "cancelled"]),
  value: Schema.Json,
  reason: Schema.optional(Schema.String),
});

export interface StepRetry {
  /** How many more times to try before the run is paused. */
  readonly times: number;
  readonly schedule?: Schedule.Schedule<unknown, unknown>;
}
// Once, unless asked: a step that posts or merges must not do it again after a lost reply.
const DEFAULT_RETRY: StepRetry = { times: 0 };

const checkStepOptions = (what: string, options: { readonly retry?: StepRetry | undefined }) => {
  checkOptions(what, options, ["returns", "retry"]);
  checkOptions(`${what}'s retry`, options?.retry, ["times", "schedule"]);
};

/** How `step.try` ended: its value, or why it failed once its retries were used up. */
export type StepAttempt<A> =
  | { readonly outcome: "done"; readonly value: A }
  | { readonly outcome: "failed"; readonly reason: string };

const attemptOf = <A, I>(returns: Schema.Codec<A, I>) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("done"), value: returns }),
    Schema.Struct({ outcome: Schema.Literal("failed"), reason: Schema.String }),
  ]);

/**
 * Do something once per run. The result is stored, and a replay returns the stored result.
 *
 * A failure is retried by `retry`, then pauses the run at this step: resuming the run runs the step
 * again. Nothing in the body can catch that. For a failure the workflow decides about, use
 * `step.try`.
 */
export const step = Object.assign(
  <A, I, E>(
    name: string,
    options: { readonly returns: Schema.Codec<A, I>; readonly retry?: StepRetry },
    code: Effect.Effect<A, E, InStep>,
  ): Effect.Effect<A, never, InRun> => {
    checkStepOptions(`step("${name}")`, options);
    return Effect.orDie(stepAs(claim(name), name, options, code));
  },
  {
    /** As `step`, but a failure left after the retries comes back as `failed` with the reason. */
    try: <A, I, E>(
      name: string,
      options: { readonly returns: Schema.Codec<A, I>; readonly retry?: StepRetry },
      code: Effect.Effect<A, E, InStep>,
    ): Effect.Effect<StepAttempt<A>, never, InRun> => {
      checkStepOptions(`step.try("${name}")`, options);
      return Effect.orDie(
        stepAs(
          claim(name),
          name,
          { returns: attemptOf(options.returns), retry: options.retry },
          code,
          (tried) =>
            tried.pipe(
              Effect.map((value): StepAttempt<A> => ({ outcome: "done", value })),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.succeed<StepAttempt<A>>({
                      outcome: "failed",
                      reason: text(Cause.squash(cause)),
                    }),
              ),
            ),
        ),
      );
    },
  },
);

const stepAs = <A, I, X, E>(
  claimed: Effect.Effect<RunContext["Service"], never, InRun>,
  name: string,
  options: { readonly returns: Schema.Codec<A, I>; readonly retry?: StepRetry | undefined },
  code: Effect.Effect<X, E, InStep>,
  // What the step makes of its tries: by default their value, or their failure.
  settle: (tried: Effect.Effect<X, E>) => Effect.Effect<A, E> = (tried) =>
    tried as unknown as Effect.Effect<A, E>,
): Effect.Effect<A, StepFailed, InRun> =>
  Effect.flatMap(claimed, (run) => {
    const retry = options.retry ?? DEFAULT_RETRY;
    const resultCodec = Schema.toCodecJson(options.returns);
    const encodeResult = Schema.encodeEffect(resultCodec);
    // Made per try, so a retry numbers its signals from the start again and counts as an attempt.
    const execute = Effect.andThen(
      run.store.stepStarted(run.runId, name, "step"),
      Effect.suspend(() => Effect.provideContext(code, run.forStep(name))),
    );
    return journaled(
      run,
      name,
      `step/${name}`,
      options.returns,
      settle(
        // A step and its retry schedule are the workflow author's own work, never sampled.
        withoutRoutineSpans(
          retry.times === 0
            ? execute
            : Effect.retry(execute, {
                times: retry.times,
                ...(retry.schedule === undefined ? {} : { schedule: retry.schedule }),
              }),
        ),
      ).pipe(
        // A value that does not encode fails the step, so it is never marked done first.
        Effect.tap((value) =>
          Effect.flatMap(
            Effect.catch(encodeResult(value), (error) => unstorable(error, value)),
            (json) =>
              Effect.andThen(
                run.store.stepEnded(run.runId, name, "completed", null),
                // For a person reading the run.
                Effect.ignore(run.store.stepResult(run.runId, name, json as Schema.Json)),
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
  const length = durationOf(`sleep("${name}")`, duration);
  const run = yield* claim(name);
  // Listed like any step, with when it wakes, so a run that sleeps for days says so.
  yield* Activity.make({
    name: `sleep/${name}/open`,
    execute: Effect.gen(function* () {
      const wakes = DateTime.addDuration(yield* DateTime.now, length);
      yield* run.store.stepStarted(run.runId, name, "sleep");
      yield* run.store.stepDetail(run.runId, name, DateTime.formatIso(wakes));
      yield* run.store.runStatus(run.runId, "waiting", `sleep ${name}`);
    }),
  });
  // Effect keeps a short sleep in memory, where a restart would start it over.
  yield* DurableClock.sleep({
    name: `sleep/${name}`,
    duration: length,
    inMemoryThreshold: Duration.zero,
  });
  yield* Activity.make({
    name: `sleep/${name}/close`,
    execute: Effect.andThen(
      run.store.stepEnded(run.runId, name, "completed", null),
      run.store.runResumed(run.runId),
    ),
  });
});

export const Woke = Schema.Struct({
  expired: Schema.Boolean,
  value: Schema.Json,
  /** Ended unanswered from outside the run, which reads it as a timeout. */
  withdrawn: Schema.optional(
    Schema.Struct({ by: Schema.String, reason: Schema.NullOr(Schema.String) }),
  ),
});
const closedDetail = (woke: typeof Woke.Type) => {
  if (woke.withdrawn !== undefined) {
    const { by, reason } = woke.withdrawn;
    return `withdrawn by ${by}${reason === null ? "" : `: ${reason}`}`;
  }
  return woke.expired ? "timed out" : null;
};
export const wakeOf = (name: string) => DurableDeferred.make(`wait/${name}`, { success: Woke });
const finite = [Schema.isFinite()] as const;
// JSON carries a bare `Schema.Number` as a number or the text "Infinity", "-Infinity" or "NaN",
// and that form drops the number's own checks. Whoever writes the value is told a finite number
// with its checks instead. Transformations and recursion keep their own form.
const finiteNumbers = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast.encoding !== undefined) return ast;
  if (SchemaAST.isNumber(ast)) {
    return new SchemaAST.Number(
      ast.annotations,
      ast.checks === undefined ? finite : [...ast.checks, ...finite],
      undefined,
      ast.context,
    );
  }
  if (SchemaAST.isObjects(ast)) {
    return new SchemaAST.Objects(
      ast.propertySignatures.map(
        (field) => new SchemaAST.PropertySignature(field.name, finiteNumbers(field.type)),
      ),
      ast.indexSignatures.map(
        (index) => new SchemaAST.IndexSignature(index.parameter, finiteNumbers(index.type)),
      ),
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isArrays(ast)) {
    return new SchemaAST.Arrays(
      ast.isMutable,
      ast.elements.map(finiteNumbers),
      ast.rest.map(finiteNumbers),
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return new SchemaAST.Union(
      ast.types.map(finiteNumbers),
      ast.options,
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  }
  return ast;
};

/** What a value must look like, as JSON Schema; `closed` objects turn down keys they do not name. */
export const jsonSchemaOf = (schema: Schema.Top, closed = false): Record<string, Schema.Json> => {
  const document = Schema.toJsonSchemaDocument(
    Schema.make(finiteNumbers(schema.ast)),
    closed ? { onExcessProperty: "error" } : undefined,
  );
  return { ...document.schema, $defs: document.definitions } as Record<string, Schema.Json>;
};

/** `wait`, also as the question a person answers: `request` is what an inbox shows them. */
export const waitAs = Effect.fn("workflow.wait")(function* <A, I>(
  kind: "wait" | "ask" | "queue",
  name: string,
  options: WaitOptions<A, I>,
): Effect.fn.Return<Option.Option<A>, StepFailed, InRun> {
  return yield* waitClaimed(yield* claim(name), kind, name, options);
});

interface WaitOptions<A, I> {
  readonly returns: Schema.Codec<A, I>;
  readonly timeout?: Duration.Input | undefined;
  readonly channel?: string | undefined;
  readonly request?: Schema.Json | undefined;
  /** What the engine looks at to end the wait by itself. */
  readonly watch?: Schema.Json | undefined;
  /** The pool a `queue` waits for a place in. */
  readonly pool?: { readonly name: string; readonly size: number } | undefined;
}

/**
 * A signal's value as a question's wait receives it: with who sent it and when, as the server saw
 * them. What the value itself says of those is the sender's word and is dropped. Undefined for a
 * wait that is not a question, a value that is no answer, and a question asked before answers
 * kept who gave them, whose closed schema would refuse the stamp.
 */
export const answerStamped = (
  wait: { readonly request: boolean; readonly schemaJson: string },
  value: Schema.Json,
  sender: WorkflowStore.SignalSender,
): Schema.JsonObject | undefined => {
  if (!wait.request || typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!wait.schemaJson.includes('"answeredAt"')) return undefined;
  const {
    answeredBy: _by,
    answeredBySession: _session,
    answeredAt: _at,
    ...given
  } = value as Schema.JsonObject;
  return {
    ...given,
    ...(sender.answeredBy === undefined ? {} : { answeredBy: sender.answeredBy }),
    // A question asked before answers kept the session has a closed schema without it.
    ...(sender.answeredBySession === undefined || !wait.schemaJson.includes('"answeredBySession"')
      ? {}
      : { answeredBySession: sender.answeredBySession }),
    answeredAt: sender.answeredAt,
  };
};

const sameAddress = (left: WorkflowStore.SignalAddress, right: WorkflowStore.SignalAddress) =>
  "runId" in left
    ? "runId" in right && left.runId === right.runId && left.wait === right.wait
    : "channel" in right && left.workflow === right.workflow && left.channel === right.channel;

const waitClaimed = Effect.fnUntraced(function* <A, I>(
  run: RunContext["Service"],
  kind: "wait" | "ask" | "queue",
  name: string,
  options: WaitOptions<A, I>,
): Effect.fn.Return<Option.Option<A>, StepFailed, InRun> {
  const here: WorkflowStore.SignalAddress = { runId: run.runId, wait: name };
  const schema = jsonSchemaOf(options.returns);
  const question = {
    request: options.request !== undefined,
    schemaJson: WorkflowStore.jsonText(schema),
  };
  const codec = Schema.toCodecJson(options.returns);
  const decode = Schema.decodeEffect(codec);
  const fits = (value: Schema.Json) => Effect.result(decode(value));
  const addresses: ReadonlyArray<WorkflowStore.SignalAddress> =
    options.channel === undefined
      ? [here]
      : [here, { workflow: run.workflow, channel: options.channel }];
  // Whatever arrived early is delivered now, checked as this wait reads it. The mail goes only
  // after the wake: waking twice is harmless, and losing the signal is not.
  const deliverEarly = Effect.fnUntraced(function* (
    wake: ReturnType<typeof wakeOf>,
    token: DurableDeferred.Token,
  ) {
    const passed = new Set<string>();
    while (true) {
      const early = yield* run.store.mailNext(addresses, passed);
      if (early === undefined) return;
      const sent = WorkflowStore.jsonValue(early.valueJson);
      // An answer is its sender's as the server recorded on receiving it. One kept before signals
      // kept that has no name, and its time is this one.
      const value =
        answerStamped(
          question,
          sent,
          early.sender ?? { answeredAt: DateTime.formatIso(yield* DateTime.now) },
        ) ?? sent;
      if (Result.isFailure(yield* fits(value))) {
        // Kept when it went to a channel: another run, or another version, may read it.
        if (sameAddress(early.address, here)) yield* run.store.mailDelete(early.signalId);
        passed.add(early.signalId);
        continue;
      }
      const woke = { expired: false, value };
      const outcome = yield* run.store.mailDeliver(early.signalId, run.runId, name, woke);
      // Another wait on the same key took that one; there may be a next.
      if (outcome === "gone") continue;
      // Another signal claimed this wait first: its wake, or the sweep, carries what it claimed.
      if (outcome === "claimed") return;
      yield* DurableDeferred.succeed(wake, { token, value: woke });
      return;
    }
  });
  const first = wakeOf(name);
  const firstToken = yield* DurableDeferred.token(first);
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
        key: options.channel,
        token: firstToken,
        schemaJson: question.schemaJson,
        requestJson: options.request === undefined ? null : WorkflowStore.jsonText(options.request),
        watchJson: options.watch === undefined ? null : WorkflowStore.jsonText(options.watch),
        deadline,
      });
      if (options.pool !== undefined) {
        yield* run.store.stepDetail(run.runId, name, options.pool.name);
        yield* run.placeAsked(name, options.pool.name, options.pool.size);
      }
      yield* run.store.runStatus(
        run.runId,
        "waiting",
        options.pool === undefined ? name : `queue ${options.pool.name}`,
      );
      // Only the pool lets a queued step in, so no signal kept for its name is delivered.
      if (options.pool === undefined) yield* deliverEarly(first, firstToken);
    }),
  });
  // A value that fit the wait's JSON Schema can still fail its codec. It was not for this wait,
  // so the wait opens again under a fresh wake instead of breaking the run on every replay.
  let wake = first;
  for (let again = 1; ; again++) {
    const woke = yield* DurableDeferred.await(wake);
    const value = woke.expired ? undefined : yield* fits(woke.value);
    if (value !== undefined && Result.isFailure(value)) {
      const problem = `It was signalled with a value it cannot read, and waits again: ${text(value.failure)}`;
      wake = wakeOf(`${name}/again/${again}`);
      const token = yield* DurableDeferred.token(wake);
      const next = wake;
      yield* Activity.make({
        name: `wait/${name}/again/${again}`,
        execute: Effect.gen(function* () {
          yield* run.store.waitReopened(run.runId, name, token);
          yield* run.store.stepDetail(run.runId, name, WorkflowStore.detailCut(problem));
          yield* deliverEarly(next, token);
        }),
      });
      continue;
    }
    yield* Activity.make({
      name: `wait/${name}/close`,
      execute: Effect.gen(function* () {
        yield* run.store.waitClosed(run.runId, name);
        yield* run.store.stepEnded(run.runId, name, "completed", closedDetail(woke));
        if (!woke.expired) yield* run.store.stepResult(run.runId, name, woke.value);
        // Kept as data, so the history can say who withdrew the question and why.
        else if (woke.withdrawn !== undefined) {
          yield* run.store.stepResult(run.runId, name, { withdrawn: woke.withdrawn });
        }
        yield* run.store.runResumed(run.runId);
      }),
    });
    return value === undefined ? Option.none() : Option.some(value.success);
  }
});

/**
 * Sleep until something outside signals this wait; `None` when the timeout passes first.
 * Addressed by run and wait name, or by `channel` (scoped to the workflow's name) when the sender
 * cannot know the run. A signal sent before the wait opened is delivered when it opens.
 */
export const wait = <A, I>(
  name: string,
  options: {
    readonly returns: Schema.Codec<A, I>;
    readonly timeout?: Duration.Input;
    readonly channel?: string;
  },
): Effect.Effect<Option.Option<A>, never, InRun> => {
  checkOptions(`wait("${name}")`, options, ["returns", "timeout", "channel"]);
  return Effect.orDie(waitAs("wait", name, options));
};

/** The pools the code running here holds a place in, and what took each. */
const PoolsHeld = Context.Reference<ReadonlyMap<string, "within" | "concurrency">>(
  "t3/workflows/workflow/PoolsHeld",
  { defaultValue: () => new Map() },
);

const checkLimit = (what: string, limit: unknown) => {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`${what} takes a whole number of places of 1 or more, as in { limit: 4 }.`);
  }
};

/**
 * Holds a place in `pool` while `body` runs, waiting first in line for one when it is full. With
 * `untilRunEnds` the place is kept past `body`, through `onEnd`, until the run ends or pauses.
 */
const holding = Effect.fn("workflow.within")(function* <A, E, R>(
  name: string,
  pool: string,
  limit: number,
  body: Effect.Effect<A, E, R>,
  untilRunEnds = false,
): Effect.fn.Return<A, E, R | InRun> {
  // Waiting for a place in a pool while holding one in it is a run that can wait for itself.
  const around = yield* PoolsHeld;
  if (around.has(pool)) {
    const outer = around.get(pool) === "concurrency";
    const workflowName = (yield* RunContext).workflow;
    return yield* Effect.die(
      new Error(
        `within("${pool}") in workflow ${workflowName} is called inside ${
          outer ? `its concurrency, which is the pool "${pool}"` : `within("${pool}")`
        }. A run cannot wait for a place in a pool it already holds one in: it could wait for itself. Take the inner one out, or name it another pool.`,
      ),
    );
  }
  const run = yield* claim(name, true);
  yield* Effect.orDie(
    waitClaimed(run, "queue", name, {
      returns: Schema.Null,
      pool: { name: pool, size: limit },
    }),
  );
  const inside = Effect.provideService(
    body,
    PoolsHeld,
    new Map(around).set(pool, untilRunEnds ? "concurrency" : "within"),
  );
  if (untilRunEnds) return yield* inside;
  // A run that pauses or ends inside gives its place back there; this is the body finishing,
  // or failing in a way its caller may catch and carry on from.
  const leave = Activity.make({ name: `${name}/leave`, execute: run.placeLeft(name) });
  const value = yield* inside.pipe(
    Effect.tapError((error) => (Predicate.isTagged(error, "StepFailed") ? Effect.void : leave)),
  );
  yield* leave;
  return value;
});

/**
 * Run `body` holding one of `limit` places in the pool `pool`, shared by every run on the server,
 * queueing first come first served when all are taken. The place is given back when `body` ends,
 * or its run pauses or ends; a resumed run takes back all it held at once, ahead of the queue.
 * `limit: 1` is a lock. Called for a pool from inside that pool, it pauses the run with an error.
 */
export const within = <A, E, R>(
  pool: string,
  options: { readonly limit: number },
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | InRun> => {
  if (typeof pool !== "string" || pool.trim() === "") {
    throw new Error(
      'within takes the pool\'s name first, as in within("builders", { limit: 4 }, …).',
    );
  }
  checkOptions(`within("${pool}")`, options, ["limit"]);
  checkLimit(`within("${pool}")`, options?.limit);
  return Effect.flatMap(RunContext, (current) => {
    // Numbered by how many came before in the body, which a replay walks the same way.
    let n = 1;
    const named = (index: number) => `${PLACE_PREFIX}${pool}${index === 1 ? "" : `#${index}`}`;
    while (current.names.has(named(n))) n++;
    return holding(named(n), pool, options.limit, body);
  });
};

/** End the run by the workflow's own decision. It ends as `stopped`, which is not a failure. */
export const stop = (reason: string): Effect.Effect<never, WorkflowStop> =>
  Effect.fail(new WorkflowStop({ reason }));

/**
 * End the run because it was not this workflow's to do: a webhook delivery it ignores, a pull
 * request it opened itself. It ends as `skipped`, which lists leave out unless asked. Use `stop`
 * for a run that did something and then decided to end.
 */
export const skip = (reason: string): Effect.Effect<never, WorkflowStop> =>
  Effect.fail(new WorkflowStop({ reason, skipped: true }));

/** Name the run in lists. Defaults to the workflow's name and the run's key. */
export const title = (
  value: string,
  ...rest: ReadonlyArray<never>
): Effect.Effect<void, never, InRun> => {
  // Files are not type-checked, so `title("name", text)` would title the run "name".
  if (typeof value !== "string" || rest.length > 0) {
    throw new Error("title takes only the text, as in title(`Release ${name}`), and no step name.");
  }
  return Effect.flatMap(RunContext, (current) => {
    // Numbered by how many came before in the body, which a replay walks the same way.
    let n = 0;
    while (current.names.has(`title/${n}`)) n++;
    const name = `title/${n}`;
    return Effect.flatMap(claim(name), (run) =>
      Activity.make({ name, execute: run.store.runTitle(run.runId, value) }),
    );
  }).pipe(Effect.orDie);
};

/**
 * Tag the run, for finding it among the others: `hyakki workflow list --tag` and `runs({ tag })`.
 * Calling it again replaces the tags.
 */
export const tags = (
  values: ReadonlyArray<string>,
  ...rest: ReadonlyArray<never>
): Effect.Effect<void, never, InRun> => {
  // Files are not type-checked, so `tags("pr", "backlog")` would tag the run with one of them.
  if (
    !Array.isArray(values) ||
    rest.length > 0 ||
    // Array.from fills a gap, as in `tags([, "pr"])`, which `some` would step over.
    Array.from(values).some((value) => typeof value !== "string" || value.trim() === "")
  ) {
    throw new Error('tags takes one list of words, as in tags(["pr", "backlog"]).');
  }
  const kept = [...new Set(values as ReadonlyArray<string>)];
  return Effect.flatMap(RunContext, (current) => {
    // Numbered by how many came before in the body, which a replay walks the same way.
    let n = 0;
    while (current.names.has(`tags/${n}`)) n++;
    const name = `tags/${n}`;
    return Effect.flatMap(claim(name), (run) =>
      Activity.make({ name, execute: run.store.runTags(run.runId, kept) }),
    );
  }).pipe(Effect.orDie);
};

/**
 * Say what the run is about: an issue or pull request a trigger or listing gave, `{ threadId }`,
 * or a web address. Lists show it and link to it, and `runs({ subject })` and
 * `hyakki workflow list --subject` find the run by it. Calling it again replaces the subject.
 */
export const subject = (
  value: SubjectInput,
  ...rest: ReadonlyArray<never>
): Effect.Effect<void, never, InRun> => {
  if (rest.length > 0) {
    throw new Error("subject takes only what the run is about, and no step name.");
  }
  const reference = subjectReference("subject", value);
  return Effect.flatMap(RunContext, (current) => {
    // Numbered by how many came before in the body, which a replay walks the same way.
    let n = 0;
    while (current.names.has(`subject/${n}`)) n++;
    const name = `subject/${n}`;
    return Effect.flatMap(claim(name), (run) =>
      Activity.make({ name, execute: subjectSet(run.store, run.runId, reference) }),
    );
  }).pipe(Effect.orDie);
};

/** What `workflow(…)`'s `asks` declares: each kind of question with the label a list shows. */
export type AskKinds = Readonly<Record<string, string>>;

/** The `asks` a workflow was given, refused when it is not kinds with a label each. */
const checkAskKinds = (workflow: string, asks: unknown): AskKinds => {
  if (asks === undefined) return {};
  const example = 'as in asks: { feature: "Feature wanted?" }';
  if (typeof asks !== "object" || asks === null || Array.isArray(asks)) {
    throw new Error(`workflow("${workflow}")'s asks is each kind with its label, ${example}.`);
  }
  for (const [kind, label] of Object.entries(asks)) {
    if (kind.trim() === "" || typeof label !== "string" || label.trim() === "") {
      throw new Error(
        `workflow("${workflow}")'s asks gives the kind "${kind}" no label. Each kind takes one, ${example}.`,
      );
    }
  }
  return { ...(asks as AskKinds) };
};

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
  readonly triggers: ReadonlyArray<ScheduleTrigger | WebhookTrigger | OpenedTrigger>;
  /** The kinds of question it asks, each with the label a list shows, in the order to show them. */
  readonly asks: AskKinds;
  /** How many of its runs may go on at once; undefined for no limit. */
  readonly concurrency: number | undefined;
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
  readonly outcome: "completed" | "stopped" | "skipped" | "cancelled";
  readonly reason: string | undefined;
}

/**
 * Run another workflow as part of this one and wait for how it ends. The other run is a run of
 * its own, listed and resumable by itself; cancelling this run cancels it. A run that paused has
 * not ended, so this waits on while someone resumes it.
 */
export const invoke = <P, A>(
  name: string,
  workflow: WorkflowDefinition<P, A>,
  payload: P,
  options?: { readonly key?: string },
): Effect.Effect<
  | { readonly outcome: "completed"; readonly value: A }
  | { readonly outcome: "stopped" | "skipped" | "cancelled"; readonly reason: string },
  never,
  InRun
> => {
  // Files are not type-checked, and a name would start nothing until its first step failed.
  if (typeof workflow !== "object" || workflow === null || typeof workflow.name !== "string") {
    return Effect.die(
      new Error(
        `invoke takes the workflow definition, not its name: invoke("${name}", …) was given ${JSON.stringify(workflow)}. Pass what workflow(…) returned.`,
      ),
    );
  }
  checkOptions(`invoke("${name}")`, options, ["key"]);
  return Effect.orDie(invokeAs(name, workflow, payload, options));
};

const invokeAs = Effect.fn("workflow.invoke")(function* <P, A>(
  name: string,
  workflow: WorkflowDefinition<P, A>,
  payload: P,
  options?: { readonly key?: string },
): Effect.fn.Return<
  | { readonly outcome: "completed"; readonly value: A }
  | { readonly outcome: "stopped" | "skipped" | "cancelled"; readonly reason: string },
  StepFailed,
  InRun
> {
  // Taken before the child starts: a name already used would refuse the wait after the start.
  const run = yield* claim(name);
  yield* step(
    `${name}/start`,
    { returns: Schema.String },
    Effect.flatMap(Runs, (runs) =>
      runs.start(workflow.name, payload, {
        version: workflow.version,
        idempotencyKey: options?.key ?? `${run.runId}/${name}`,
        parent: { runId: run.runId, wait: name },
      }),
    ).pipe(Effect.map((started) => started.runId)),
  );
  const ended = yield* waitClaimed(run, "wait", name, { returns: ChildEnd });
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

/** Starts the name of every step that waits for a place in a pool, and of no step of a body. */
const PLACE_PREFIX = "@pool:";
/** The step `onEnd` runs as. */
export const END_STEP = "onEnd";
const END_RETRY: StepRetry = { times: 3, schedule: Schedule.exponential("2 seconds") };

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
     * The kinds of question this workflow asks, each with the label a list shows, in the order
     * to show them: an `ask` names one as its `kind`. A question of a kind that is not here is
     * listed as Other.
     */
    readonly asks?: AskKinds;
    /** How many runs of this workflow go on at once, across its versions. Later ones queue. */
    readonly concurrency?: number;
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
): WorkflowDefinition<P, A> => {
  checkOptions(`workflow("${name}")`, options, [
    "version",
    "payload",
    "returns",
    "resumeAfter",
    "triggers",
    "asks",
    "concurrency",
    "onEnd",
  ]);
  if (options.concurrency !== undefined) {
    checkLimit(`workflow("${name}")'s concurrency`, options.concurrency);
  }
  // Read once now, so a duration that does not parse fails the file and not a paused run later.
  for (const rest of options.resumeAfter ?? [])
    durationOf(`workflow("${name}")'s resumeAfter`, rest);
  checkTriggers(name, options.triggers ?? []);
  checkAskKinds(name, options.asks);
  return definitionOf(name, options, body);
};

const definitionOf = <P, PI, A, AI, EndError>(
  name: string,
  options: Parameters<typeof workflow<P, PI, A, AI, EndError>>[1],
  body: Parameters<typeof workflow<P, PI, A, AI, EndError>>[2],
): WorkflowDefinition<P, A> => ({
  name,
  version: options.version,
  // Erased here, once: the registry holds workflows of every payload and result type.
  payload: options.payload as Schema.Codec<unknown, unknown>,
  // Without a schema the result is whatever JSON the body returned: dropping it would be a
  // surprise, and a value that is not JSON pauses the run with the reason.
  returns: (options.returns ?? ANY_JSON) as Schema.Codec<unknown, unknown>,
  resumeAfter: options.resumeAfter ?? DEFAULT_RESUME_AFTER,
  triggers: options.triggers ?? [],
  asks: checkAskKinds(name, options.asks),
  concurrency: options.concurrency,
  onEnd:
    options.onEnd === undefined
      ? undefined
      : (payload, end) => options.onEnd!(payload, end).pipe(Effect.asVoid, Effect.mapError(text)),
  body,
});

export const engineTag = (definition: Pick<WorkflowDefinition, "name" | "version">) =>
  `${definition.name}@${definition.version}`;

const Outcome = Schema.Struct({
  outcome: Schema.Literals(["completed", "stopped", "skipped"]),
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
      const forge = Option.getOrElse(yield* Effect.serviceOption(WorkflowForge), () => unavailable);
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
      const body = definition.body(input, { id: runId });
      const outcome = yield* (
        definition.concurrency === undefined
          ? body
          : holding(
              `${PLACE_PREFIX}${definition.name}`,
              definition.name,
              definition.concurrency,
              body,
              true,
            )
      ).pipe(
        Effect.flatMap((value) =>
          definition.returns === ANY_JSON
            ? untypedResult(value)
            : encodeResult(value).pipe(
                Effect.mapError(
                  (error) =>
                    new Error(
                      `The run's result does not fit its returns: ${encodeFailure("the run's result", error, value)}`,
                    ),
                ),
                Effect.orDie,
              ),
        ),
        Effect.map((value): typeof Outcome.Type => ({
          outcome: "completed",
          value: (value ?? null) as Schema.Json,
        })),
        Effect.catchTags({
          WorkflowStop: (stopped) =>
            Effect.succeed<typeof Outcome.Type>({
              outcome: stopped.skipped === true ? "skipped" : "stopped",
              value: null,
              reason: stopped.reason,
            }),
        }),
        // A step like any other: a cleanup that fails pauses the run, and resuming tries it again.
        Effect.tap((ended) =>
          definition.onEnd === undefined
            ? Effect.void
            : stepAs(
                claim(END_STEP, true),
                END_STEP,
                // A cleanup is safe to run again, and has nobody else to try it.
                { returns: Schema.Void, retry: END_RETRY },
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
            forStep: (name) => forStep(store, keyValues, link, forge, runId, name),
            inFlight: link.inFlight,
            watchTurn: Effect.fn("RunContext.watchTurn")(function* (wait: string) {
              if (link.current !== undefined) yield* link.current.watchTurn(runId, wait);
            }),
            placeAsked: Effect.fn("RunContext.placeAsked")(function* (name, pool, size) {
              if (link.current !== undefined) {
                yield* link.current.placeAsked({ runId, name, pool, size });
              }
            }),
            placeLeft: Effect.fn("RunContext.placeLeft")(function* (name) {
              if (link.current !== undefined) yield* link.current.placeLeft(runId, name);
            }),
            placesFreed: Effect.suspend(() => link.current?.placesFreed ?? Effect.void),
          }),
        ),
      );
      yield* Activity.make({
        name: "run/end",
        execute: Effect.andThen(
          store.runEnded(runId, outcome.outcome, outcome.reason ?? null, outcome.value),
          // What it still held, as a run that stops inside `within` does, goes to the next.
          Effect.suspend(() => link.current?.placesFreed ?? Effect.void),
        ),
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
          : Effect.gen(function* () {
              const store = yield* WorkflowStore.WorkflowStore;
              const link = yield* EngineLink;
              yield* store.runPaused(runId, text(Cause.squash(cause)));
              if (link.current !== undefined) yield* link.current.placesFreed;
            }),
      ),
    ),
  );
};

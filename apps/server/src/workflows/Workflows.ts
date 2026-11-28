import {
  type WorkflowCounts,
  type WorkflowHook,
  WorkflowQuestion,
  type WorkflowRunReference,
  type WorkflowRunsAboutInput,
  applyWorkflowRunsUpdate,
  type WorkflowRunsSnapshot,
  type WorkflowRunsUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { WebhookRequest } from "./triggers.ts";
import type * as WorkflowStore from "./WorkflowStore.ts";

/** Hook ids of workflows start with this; a scheduled task's hook id never does. */
export const HOOK_PREFIX = "wf-";

// The dot between the two parts is never in either, so no two hooks share an id.
const hookPart = (part: string) => encodeURIComponent(part).replaceAll(".", "%2E");
/** The id of the hook `name` of `workflow`, which its URL and its secret are kept by. */
export const hookId = (workflow: string, name: string) =>
  `${HOOK_PREFIX}${hookPart(workflow)}.${hookPart(name)}`;

export class WorkflowNotRegisteredError extends Schema.TaggedError<WorkflowNotRegisteredError>()(
  "WorkflowNotRegisteredError",
  { workflow: Schema.String, version: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.version === undefined
      ? `No workflow named ${this.workflow} is registered.`
      : `Version ${this.version} of workflow ${this.workflow} is not registered.`;
  }
}

export class WorkflowRunNotFoundError extends Schema.TaggedError<WorkflowRunNotFoundError>()(
  "WorkflowRunNotFoundError",
  { runId: Schema.String },
) {
  override get message(): string {
    return `Workflow run ${this.runId} was not found.`;
  }
}

export class WorkflowInputError extends Schema.TaggedError<WorkflowInputError>()(
  "WorkflowInputError",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

/** A hook that has started as many runs as it may for now. */
export class WorkflowHookBusyError extends Schema.TaggedError<WorkflowHookBusyError>()(
  "WorkflowHookBusyError",
  { hook: Schema.String },
) {
  override get message(): string {
    return `Hook ${this.hook} has started as many runs as it may in a minute.`;
  }
}

export { WorkflowQuestion };

export type WorkflowError =
  | WorkflowNotRegisteredError
  | WorkflowRunNotFoundError
  | WorkflowInputError
  | WorkflowHookBusyError;

export interface WorkflowRunsListResult {
  readonly runs: ReadonlyArray<WorkflowStore.WorkflowRun>;
  /** Older runs in this list (outside top-level skipped runs when unfiltered) were omitted at the limit. */
  readonly truncated: boolean;
  /** Older top-level skipped runs were omitted at their separate limit (only on unfiltered lists). */
  readonly skippedTruncated?: boolean | undefined;
}

export class Workflows extends Context.Service<
  Workflows,
  {
    /** Start a run. A second start with the same key is the same run. */
    readonly start: (
      workflow: string,
      input: unknown,
      options: {
        readonly idempotencyKey: string;
        /** The run that waits for this one. A run started with a key has one parent or none. */
        readonly parent?: WorkflowStore.RunParent;
        /** The version to run, when the caller holds a definition. Without it, the newest. */
        readonly version?: number;
        /** What a new run is about. A start that finds its run already there leaves it be. */
        readonly subject?: WorkflowStore.ReferenceInput;
      },
    ) => Effect.Effect<{ readonly runId: string }, WorkflowError>;
    /**
     * Say that something a run waits on happened. `delivered` woke a wait; `buffered` is kept for
     * a wait that has not opened yet, for `ttl` (seven days by default).
     */
    readonly signal: (
      address: WorkflowStore.SignalAddress,
      value: Schema.Json,
      options: {
        readonly id: string;
        readonly ttl?: Duration.Input;
        /** Who sent it, kept with an answer to a question. */
        readonly answeredBy?: string | undefined;
        /** The client session that sent it, where one did. A name is shared; this is not. */
        readonly answeredBySession?: string | undefined;
      },
    ) => Effect.Effect<"delivered" | "buffered", WorkflowInputError>;
    /**
     * Answer the question a run asks a person. One answer per time it is asked: a second, a
     * double click, wakes nothing and is not kept for later.
     */
    readonly answer: (
      runId: string,
      name: string,
      value: Schema.Json,
      /** Who answered, as the server knows them; kept with the answer. */
      answeredBy?: { readonly label: string; readonly sessionId?: string | undefined },
    ) => Effect.Effect<void, WorkflowInputError>;
    /** Run a paused run's failed step again. */
    readonly resume: (runId: string) => Effect.Effect<void, WorkflowError>;
    readonly cancel: (runId: string, reason?: string) => Effect.Effect<void, WorkflowError>;
    /**
     * End a run's open question unanswered, as its timeout would: its `ask` returns `None` and the
     * run goes on. `not_open` when the question was answered, timed out or never asked.
     */
    readonly withdraw: (
      runId: string,
      name: string,
      options: { readonly by: string; readonly reason?: string | undefined },
    ) => Effect.Effect<"withdrawn" | "not_open", WorkflowError>;
    readonly get: (runId: string) => Effect.Effect<
      {
        readonly run: WorkflowStore.WorkflowRun;
        readonly steps: ReadonlyArray<WorkflowStore.WorkflowStep>;
        readonly references: ReadonlyArray<WorkflowRunReference>;
      },
      WorkflowRunNotFoundError | WorkflowInputError
    >;
    readonly list: (filter?: {
      readonly status?: WorkflowStore.WorkflowRunStatus;
      /** Only runs their workflow tagged with this. */
      readonly tag?: string;
      /** Only runs about this: their subject's web address, or its key, such as a thread id. */
      readonly subject?: string;
    }) => Effect.Effect<WorkflowRunsListResult, WorkflowInputError>;
    /**
     * The runs about an item, by its web address (as `list` reads `subject`) or by the issue or
     * pull request it is, and the questions they have open, for the item's own view: the runs
     * list is the newest runs of every subject.
     */
    readonly about: (item: WorkflowRunsAboutInput) => Effect.Effect<
      {
        readonly runs: ReadonlyArray<WorkflowStore.WorkflowRun>;
        readonly questions: ReadonlyArray<WorkflowQuestion>;
      },
      WorkflowInputError
    >;
    /** The run once `done` holds for it. Looks now, then on every change to the run. */
    readonly waitFor: (
      runId: string,
      done: (run: WorkflowStore.WorkflowRun) => boolean,
    ) => Effect.Effect<WorkflowStore.WorkflowRun>;
    /** The questions runs are waiting on a person to answer, oldest first. */
    readonly questions: Effect.Effect<ReadonlyArray<WorkflowQuestion>, WorkflowInputError>;
    /** What each run that has not ended is a run of, however many: no list limit applies. */
    readonly unfinished: Effect.Effect<
      ReadonlyArray<{ readonly workflow: string; readonly version: number }>
    >;
    /** The hook URLs of the registered workflows. */
    readonly hooks: Effect.Effect<ReadonlyArray<WorkflowHook>, WorkflowInputError>;
    /**
     * Start the run a request to a hook asks for. Nothing, for a hook or token that is not known.
     * `deliveryId` names the delivery when its carrier vouches for one, so its retry is one run.
     * A hook starts a bounded number of new runs a minute and is busy past that.
     */
    readonly deliver: (delivery: {
      readonly hookId: string;
      readonly token: string;
      readonly request: WebhookRequest;
      readonly deliveryId?: string;
    }) => Effect.Effect<Option.Option<{ readonly runId: string }>, WorkflowError>;
    /** What workflows keep in the store under keys starting with `prefix`, for a person to see. */
    readonly stored: (
      prefix: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly key: string; readonly value: Schema.Json }>,
      WorkflowInputError
    >;
    /** Set a key of the store from outside a run, as a person flipping a switch does. */
    readonly storeSet: (key: string, value: Schema.Json) => Effect.Effect<void, WorkflowInputError>;
    readonly storeDelete: (key: string) => Effect.Effect<void, WorkflowInputError>;
    /** Recent runs and open questions now, then what changed of them after every change. */
    readonly watch: Stream.Stream<WorkflowRunsUpdate>;
    /** How much is going on, now and again whenever a count changes. */
    readonly counts: Stream.Stream<WorkflowCounts>;
    /**
     * Deliver timeouts to waits past their deadline, drop expired mail, and resume paused runs
     * whose rest is over. Runs by itself every few seconds.
     */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/workflows/Workflows") {}

const refuse = Effect.fn("Workflows.disabled")(function* () {
  return yield* new WorkflowInputError({
    problem:
      "This server defines no workflows yet. Add a file to the workflows folder of its T3 home.",
  });
});

/** The service with nothing registered and no engine behind it. */
export const disabled = Workflows.of({
  start: refuse,
  signal: refuse,
  answer: refuse,
  resume: refuse,
  cancel: refuse,
  withdraw: refuse,
  get: Effect.fn("Workflows.get")(function* (runId) {
    return yield* new WorkflowRunNotFoundError({ runId });
  }),
  list: Effect.fn("Workflows.list")(function* () {
    return yield* Effect.succeed({ runs: [], truncated: false });
  }),
  about: Effect.fn("Workflows.about")(function* () {
    return yield* Effect.succeed({ runs: [], questions: [] });
  }),
  waitFor: Effect.fn("Workflows.waitFor")(function* () {
    return yield* Effect.never;
  }),
  questions: Effect.succeed([]),
  unfinished: Effect.succeed([]),
  hooks: Effect.succeed([]),
  deliver: Effect.fn("Workflows.deliver")(function* () {
    return yield* Effect.succeed(Option.none<{ readonly runId: string }>());
  }),
  stored: Effect.fn("Workflows.stored")(function* () {
    return yield* Effect.succeed<ReadonlyArray<{ key: string; value: Schema.Json }>>([]);
  }),
  storeSet: refuse,
  storeDelete: refuse,
  watch: Stream.concat(Stream.make({ workflows: [], runs: [], questions: [] }), Stream.never),
  counts: Stream.concat(Stream.make({ needsYou: 0, active: 0, total: 0 }), Stream.never),
  sweep: Effect.void,
});
export const layerDisabled = Layer.succeed(Workflows, disabled);

/** What `watch` sends, as the whole list every time: for a client that did not ask for changes. */
export const wholeLists = (updates: Stream.Stream<WorkflowRunsUpdate>) =>
  updates.pipe(
    Stream.mapAccum(
      (): WorkflowRunsSnapshot | undefined => undefined,
      (list, update) => {
        const next = applyWorkflowRunsUpdate(list, update);
        return [next, [next]] as const;
      },
    ),
  );

export const OFF =
  'Workflows are off on this server. Turn them on in its Settings → Labs → Workflows, or without a desktop, set "workflowsEnabled": true in userdata/settings.json in its T3 home (~/.t3 by default).';

const refuseOff = Effect.fn("Workflows.off")(function* () {
  return yield* new WorkflowInputError({ problem: OFF });
});

/**
 * The service while workflows are off: every request is refused, and a hook answers as one that
 * is not there.
 */
export const off = Workflows.of({
  ...disabled,
  start: refuseOff,
  signal: refuseOff,
  answer: refuseOff,
  resume: refuseOff,
  cancel: refuseOff,
  withdraw: refuseOff,
  get: refuseOff,
  list: refuseOff,
  about: refuseOff,
  questions: refuseOff(),
  hooks: refuseOff(),
  stored: refuseOff,
  storeSet: refuseOff,
  storeDelete: refuseOff,
});

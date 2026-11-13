import {
  type WorkflowCounts,
  type WorkflowHook,
  WorkflowQuestion,
  type WorkflowRunsSnapshot,
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

export class WorkflowNotRegisteredError extends Schema.TaggedError<WorkflowNotRegisteredError>()(
  "WorkflowNotRegisteredError",
  { workflow: Schema.String },
) {
  override get message(): string {
    return `No workflow named ${this.workflow} is registered.`;
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

export { WorkflowQuestion };

export type WorkflowError =
  | WorkflowNotRegisteredError
  | WorkflowRunNotFoundError
  | WorkflowInputError;

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
      },
    ) => Effect.Effect<{ readonly runId: string }, WorkflowError>;
    /**
     * Say that something a run waits on happened. `delivered` woke a wait; `buffered` is kept for
     * a wait that has not opened yet, for `ttl` (seven days by default).
     */
    readonly signal: (
      address: WorkflowStore.SignalAddress,
      value: Schema.Json,
      options: { readonly id: string; readonly ttl?: Duration.Input },
    ) => Effect.Effect<"delivered" | "buffered", WorkflowInputError>;
    /** Run a paused run's failed step again. */
    readonly resume: (runId: string) => Effect.Effect<void, WorkflowError>;
    readonly cancel: (runId: string, reason: string) => Effect.Effect<void, WorkflowError>;
    readonly get: (runId: string) => Effect.Effect<
      {
        readonly run: WorkflowStore.WorkflowRun;
        readonly steps: ReadonlyArray<WorkflowStore.WorkflowStep>;
      },
      WorkflowRunNotFoundError
    >;
    readonly list: (filter?: {
      readonly status?: WorkflowStore.WorkflowRunStatus;
    }) => Effect.Effect<ReadonlyArray<WorkflowStore.WorkflowRun>>;
    /** The run once `done` holds for it. Looks now, then on every change to the run. */
    readonly waitFor: (
      runId: string,
      done: (run: WorkflowStore.WorkflowRun) => boolean,
    ) => Effect.Effect<WorkflowStore.WorkflowRun>;
    /** The questions runs are waiting on a person to answer, oldest first. */
    readonly questions: Effect.Effect<ReadonlyArray<WorkflowQuestion>>;
    /** The hook URLs of the registered workflows. */
    readonly hooks: Effect.Effect<ReadonlyArray<WorkflowHook>>;
    /**
     * Start the run a request to a hook asks for. Nothing, for a hook or token that is not known.
     * `deliveryId` names the delivery when its carrier vouches for one, so its retry is one run.
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
    ) => Effect.Effect<ReadonlyArray<{ readonly key: string; readonly value: Schema.Json }>>;
    /** Set a key of the store from outside a run, as a person flipping a switch does. */
    readonly storeSet: (key: string, value: Schema.Json) => Effect.Effect<void, WorkflowInputError>;
    readonly storeDelete: (key: string) => Effect.Effect<void, WorkflowInputError>;
    /** Recent runs and open questions, now and again after every change. */
    readonly watch: Stream.Stream<WorkflowRunsSnapshot>;
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
    problem: "Workflows are not enabled on this server: no definitions module is configured.",
  });
});

/** The service with nothing registered and no engine behind it. */
export const layerDisabled = Layer.succeed(
  Workflows,
  Workflows.of({
    start: refuse,
    signal: refuse,
    resume: refuse,
    cancel: refuse,
    get: Effect.fn("Workflows.get")(function* (runId) {
      return yield* new WorkflowRunNotFoundError({ runId });
    }),
    list: Effect.fn("Workflows.list")(function* () {
      return yield* Effect.succeed<ReadonlyArray<WorkflowStore.WorkflowRun>>([]);
    }),
    waitFor: Effect.fn("Workflows.waitFor")(function* () {
      return yield* Effect.never;
    }),
    questions: Effect.succeed([]),
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
  }),
);

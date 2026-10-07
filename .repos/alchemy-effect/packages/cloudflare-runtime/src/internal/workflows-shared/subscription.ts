// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: uses Effect Schema instead of Zod, preserving strict option validation.
import { RpcTarget } from "cloudflare:workers";
import { ms } from "itty-time";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type { ResolvedStepConfig } from "./context.ts";

const WorkflowSubscriptionEventCommonSchema = Schema.Struct({
  instanceId: Schema.String,
  eventId: Schema.Number.check(Schema.isFinite()),
  timestamp: Schema.Number.check(Schema.isFinite()),
});
const StepDurationSchema = Schema.declare<ResolvedStepConfig["timeout"]>(
  (value): value is ResolvedStepConfig["timeout"] =>
    typeof value === "number" ||
    (typeof value === "string" && !Number.isNaN(ms(value))),
);
const ResolvedStepDelaySchema = Schema.Union([
  StepDurationSchema,
  Schema.Literal("[dynamic]"),
]);
const ResolvedStepConfigSchema = Schema.Struct({
  retries: Schema.Struct({
    limit: Schema.declare<number>(
      (value): value is number =>
        typeof value === "number" &&
        (Number.isFinite(value) || value === Infinity),
    ),
    delay: ResolvedStepDelaySchema,
    backoff: Schema.optional(
      Schema.Literals(["constant", "linear", "exponential"]),
    ),
  }),
  timeout: StepDurationSchema,
  sensitive: Schema.optional(Schema.Literal("output")),
});

/**
 * Parses a resolved step config read from persisted local Workflow state.
 *
 * @param value Persisted value to parse.
 * @returns The resolved config, or `undefined` when the value is invalid.
 */
export function parseResolvedStepConfig(value: unknown) {
  const result = Schema.decodeUnknownResult(ResolvedStepConfigSchema)(value);
  return Result.isSuccess(result) ? result.success : undefined;
}
const WorkflowSubscriptionEventSchema = Schema.Union([
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_queued"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_started"),
    params: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_running"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_paused"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_waiting_for_pause"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_waiting"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_completed"),
    output: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_errored"),
    error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("workflow_terminated"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("step_started"),
    stepName: Schema.String,
    config: Schema.optional(ResolvedStepConfigSchema),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("step_completed"),
    stepName: Schema.String,
    output: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("step_errored"),
    stepName: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("attempt_started"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("attempt_completed"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("attempt_errored"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
    retryDelayMs: Schema.optional(Schema.Number.check(Schema.isFinite())),
    error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("sleep_started"),
    stepName: Schema.String,
    durationMs: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("sleep_completed"),
    stepName: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("wait_started"),
    stepName: Schema.String,
    eventType: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("wait_completed"),
    stepName: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("wait_timed_out"),
    stepName: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_started"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_step_started"),
    stepName: Schema.String,
    config: Schema.optional(ResolvedStepConfigSchema),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_step_completed"),
    stepName: Schema.String,
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_step_errored"),
    stepName: Schema.String,
    error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_attempt_started"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_attempt_completed"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_attempt_errored"),
    stepName: Schema.String,
    attempt: Schema.Number.check(Schema.isFinite()),
    retryDelayMs: Schema.optional(Schema.Number.check(Schema.isFinite())),
    error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_completed"),
  }),
  Schema.Struct({
    ...WorkflowSubscriptionEventCommonSchema.fields,
    type: Schema.Literal("rollback_errored"),
  }),
]);

export type WorkflowSubscriptionEvent =
  typeof WorkflowSubscriptionEventSchema.Type;

const workflowSubscriptionEventTypeNames = new Set(
  WorkflowSubscriptionEventSchema.members.map(
    (option) => option.fields.type.literal,
  ),
);
const WorkflowSubscriptionEventTypeSchema = Schema.declare<
  WorkflowSubscriptionEvent["type"]
>(
  (value): value is WorkflowSubscriptionEvent["type"] =>
    typeof value === "string" &&
    workflowSubscriptionEventTypeNames.has(
      value as WorkflowSubscriptionEvent["type"],
    ),
);

export type WorkflowSubscriptionOptions = {
  cursor?: number;
  filter?: Array<WorkflowSubscriptionEvent["type"]>;
};

const WORKFLOW_SUBSCRIPTION_OPTIONS_SCHEMA = Schema.Struct({
  cursor: Schema.optional(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  ),
  filter: Schema.optional(
    Schema.mutable(Schema.Array(WorkflowSubscriptionEventTypeSchema)),
  ),
});

export function parseWorkflowSubscriptionOptions(options: unknown) {
  if (options === undefined) {
    return {} satisfies WorkflowSubscriptionOptions;
  }

  const parsed = Schema.decodeUnknownResult(
    WORKFLOW_SUBSCRIPTION_OPTIONS_SCHEMA,
  )(options, { onExcessProperty: "error" });
  if (Result.isFailure(parsed)) {
    throw new Error("Invalid Workflow subscription options");
  }

  return parsed.success satisfies WorkflowSubscriptionOptions;
}

export type WorkflowSubscriptionState = {
  instanceId: string;
  params: unknown;
  lastEventId: number;
  filter: ReadonlySet<WorkflowSubscriptionEvent["type"]> | undefined;
  waiter: { resolve: () => void } | undefined;
  closed: boolean;
};

export interface WorkflowSubscription extends Disposable {
  next(): Promise<IteratorResult<WorkflowSubscriptionEvent, undefined>>;
}

export function isTerminalEvent(event: WorkflowSubscriptionEvent): boolean {
  return (
    event.type === "workflow_completed" ||
    event.type === "workflow_errored" ||
    event.type === "workflow_terminated"
  );
}

export class WorkflowSubscriptionTarget
  extends RpcTarget
  implements WorkflowSubscription
{
  readonly #nextEvent: () => Promise<
    IteratorResult<WorkflowSubscriptionEvent, undefined>
  >;
  readonly #onClose: () => void;
  #nextRequest = Promise.resolve<unknown>(undefined);
  #closed = false;

  constructor(
    nextEvent: () => Promise<
      IteratorResult<WorkflowSubscriptionEvent, undefined>
    >,
    onClose: () => void,
  ) {
    super();
    this.#nextEvent = nextEvent;
    this.#onClose = onClose;
  }

  async next(): Promise<IteratorResult<WorkflowSubscriptionEvent, undefined>> {
    if (this.#closed) {
      return { done: true, value: undefined };
    }

    const request = this.#nextRequest.then(async () => {
      if (this.#closed) {
        return { done: true, value: undefined } as const;
      }

      try {
        const result = await this.#nextEvent();
        if (this.#closed) {
          return { done: true, value: undefined } as const;
        }
        if (result.done || isTerminalEvent(result.value)) {
          this.#finish();
        }
        return result;
      } catch (error) {
        this.#finish();
        throw error;
      }
    });
    this.#nextRequest = request;
    return request;
  }

  [Symbol.dispose](): void {
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#onClose();
  }
}

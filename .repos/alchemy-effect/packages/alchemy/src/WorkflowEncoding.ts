import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Workflow } from "effect/workflow";

/**
 * How the workflow engines store what a run produces as JSON: step and signal
 * exits, payloads, and a workflow's own result.
 *
 * @internal
 */

const ExitJson = Schema.toCodecJson(Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Defect()));

/**
 * Activity and deferred exits arrive with their values already encoded; a
 * void value is stored as null, since undefined isn't JSON.
 */
export const encodeExit = (exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeEffect(ExitJson)(Exit.map(exit, (value) => value ?? null)).pipe(
    Effect.map(JSON.stringify),
    Effect.orDie,
  );

export const decodeExit = (text: string) =>
  Schema.decodeEffect(ExitJson)(JSON.parse(text)).pipe(Effect.orDie);

/**
 * The schemas a workflow's payload and result are stored through. Concrete
 * `Workflow`s don't assign to Effect's own `Workflow.AnyWithProps` (its
 * `execute` options), so accept just what encoding reads.
 */
export type WorkflowSchemas = Pick<
  Workflow.AnyWithProps,
  "payloadSchema" | "successSchema" | "errorSchema"
>;

export const payloadCodec = (workflow: WorkflowSchemas) =>
  Schema.toCodecJson(workflow.payloadSchema) as unknown as Schema.Codec<unknown, unknown>;

interface ResultCodec {
  readonly encode: (
    exit: Exit.Exit<unknown, unknown>,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly decode: (
    value: unknown,
  ) => Effect.Effect<Exit.Exit<unknown, unknown>, Schema.SchemaError>;
}

// Schemas are immutable values. Key by both current schema objects instead of
// the workflow name or definition, so replaced schemas never reuse a stale codec.
const resultCodecs = new WeakMap<Schema.Top, WeakMap<Schema.Top, ResultCodec>>();

const resultCodec = (workflow: WorkflowSchemas): ResultCodec => {
  const { successSchema, errorSchema } = workflow;
  let errors = resultCodecs.get(successSchema);
  if (errors === undefined) {
    errors = new WeakMap();
    resultCodecs.set(successSchema, errors);
  }
  let cached = errors.get(errorSchema);
  if (cached === undefined) {
    const codec = Schema.toCodecJson(
      Schema.Exit(successSchema, errorSchema, Schema.Defect()),
    ) as unknown as Schema.Codec<Exit.Exit<unknown, unknown>, unknown>;
    cached = {
      encode: Schema.encodeEffect(codec),
      decode: Schema.decodeEffect(codec),
    };
    errors.set(errorSchema, cached);
  }
  return cached;
};

/** A workflow's own result is stored through its success and error schemas. */
export const encodeResult = (workflow: WorkflowSchemas, exit: Exit.Exit<unknown, unknown>) =>
  resultCodec(workflow).encode(exit).pipe(Effect.map(JSON.stringify), Effect.orDie);

export const decodeResult = (workflow: WorkflowSchemas, text: string) =>
  resultCodec(workflow)
    .decode(JSON.parse(text))
    .pipe(
      Effect.map((exit) => new Workflow.Complete({ exit })),
      Effect.orDie,
    );

/**
 * The step a workflow engine is running: provided around each `Activity` so
 * the step's own work can derive stable ids from it. A step that runs again,
 * after a retry or a crash, sees the same values.
 *
 * @internal
 */
export class CurrentActivity extends Context.Service<
  CurrentActivity,
  {
    readonly workflow: string;
    readonly executionId: string;
    readonly activity: string;
    /** The next id in this step's sequence, restarting on every attempt. */
    readonly next: () => string;
  }
>()("alchemy/Workflow/CurrentActivity") {}

/** @internal */
export const makeCurrentActivity = (
  workflow: string,
  executionId: string,
  activity: string,
): CurrentActivity["Service"] => {
  let sequence = 0;
  return {
    workflow,
    executionId,
    activity,
    next: () => `${workflow}/${executionId}/${activity}/${++sequence}`,
  };
};

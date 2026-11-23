import {
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  parseGoalCommand,
  type RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import { contextBoundaryOrdinal } from "./contextBoundary.ts";

/**
 * Latest completed run on the thread that still owes a typed result, ignoring context boundaries.
 * Only the newest started run asked for a result can owe it.
 */
export function latestOwedOutputRun<
  TRun extends {
    readonly id: RunId;
    readonly ordinal: number;
    readonly status: OrchestrationV2Run["status"];
    readonly startedAt?: OrchestrationV2Run["startedAt"];
    readonly restartContinuationOfRunId?: OrchestrationV2Run["restartContinuationOfRunId"];
    readonly outputSchema?: unknown;
    readonly output?: unknown;
  },
>(runs: ReadonlyArray<TRun>): TRun | undefined {
  let asked: TRun | undefined;
  for (const candidate of runs) {
    if (
      candidate.outputSchema !== undefined &&
      candidate.status !== "queued" &&
      !cancelledBeforeStart({
        status: candidate.status,
        startedAt: candidate.startedAt ?? null,
        ...(candidate.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: candidate.restartContinuationOfRunId }),
      }) &&
      (asked === undefined || candidate.ordinal > asked.ordinal)
    ) {
      asked = candidate;
    }
  }
  return asked?.status === "completed" && asked.output === undefined ? asked : undefined;
}

/**
 * Latest completed run that still owes a typed result and remains reachable in the agent's
 * current conversation. Loads `turnItems` only when a later fresh-context run exists.
 */
export const resolveOwedOutputRun = <E, R>(
  runs: ReadonlyArray<OrchestrationV2Run>,
  loadContextRecords: () => Effect.Effect<
    Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
    E,
    R
  >,
): Effect.Effect<OrchestrationV2Run | undefined, E, R> => {
  const owing = latestOwedOutputRun(runs);
  if (
    owing === undefined ||
    !runs.some((later) => later.freshContext === true && later.ordinal > owing.ordinal)
  ) {
    return Effect.succeed(owing);
  }
  return loadContextRecords().pipe(
    Effect.map((records) => (contextBoundaryOrdinal(records) > owing.ordinal ? undefined : owing)),
  );
};

/** Whether a turn needs its MCP credential rotated to match its run/attempt identity. */
export const runRequiresRunScopedMcp = <E, R>(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runId: RunId | undefined,
  currentCredentialRunId: RunId | undefined,
  loadContextRecords: () => Effect.Effect<
    Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
    E,
    R
  >,
): Effect.Effect<boolean, E, R> => {
  if (
    runId !== undefined &&
    runs.some((candidate) => candidate.id === runId && candidate.outputSchema !== undefined)
  ) {
    return Effect.succeed(true);
  }
  return resolveOwedOutputRun(runs, loadContextRecords).pipe(
    Effect.map((owed) => owed !== undefined && currentCredentialRunId !== owed.id),
  );
};

type OutputSchema = Readonly<Record<string, Schema.Json>>;

// A schema built from JSON Schema needs no services, which its `Schema.Top` type cannot say.
const compile = (schema: OutputSchema) =>
  Result.try(
    () =>
      SchemaRepresentation.fromJsonSchemaDocument(
        JsonSchema.fromSchemaDraft2020_12(schema),
      ) as Schema.Codec<unknown>,
  );

// The schema travels with the run to every client, and into the prompt of every turn that owes it.
const MAX_SCHEMA_CHARS = 32_000;

/** Why a declared output schema cannot be used, or null when it can. */
const outputSchemaProblem = (schema: OutputSchema): string | null =>
  JSON.stringify(schema).length > MAX_SCHEMA_CHARS
    ? `The output schema is larger than ${MAX_SCHEMA_CHARS} characters.`
    : Result.isFailure(compile(schema))
      ? "The output schema is not a usable JSON Schema."
      : null;

/** Whether a message is a command its provider runs itself, which takes no appended instructions. */
export const isProviderCommand = (message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): boolean =>
  (message.attachments?.length ?? 0) === 0 &&
  (["/compact", "/logout"].includes(message.text.trim().toLowerCase()) ||
    parseGoalCommand(message) !== null);

/** Why a message cannot be asked for a result under this schema, or null when it can. */
export const outputRequestProblem = (
  schema: OutputSchema,
  message: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> | undefined },
): string | null =>
  isProviderCommand(message)
    ? "A command cannot be asked for a result. Ask for it in a message."
    : outputSchemaProblem(schema);

/** Appended to the turn's prompt: the agent learns the shape and how to hand the result back. */
export const outputInstructions = (schema: OutputSchema, runId: RunId): string =>
  [
    "A program reads the result of this turn, not a person.",
    `When the work is done, call the \`t3_submit_output\` tool once with \`runId\` set to \`${runId}\` and \`json\` set to JSON text matching this JSON Schema:`,
    JSON.stringify(schema),
    "If you could not finish, still submit, with the fields that say so. A rejected submission names what did not fit: correct it and submit again.",
  ].join("\n");

/** Why a submission was turned down. What did not fit is in `cause`, never in the problem. */
export interface OutputRejection {
  readonly problem: string;
  readonly cause?: unknown;
}

/** The rejection as told to whoever wrote the value: the problem, then what in it did not fit. */
export const rejectionText = (rejection: OutputRejection): string =>
  rejection.cause instanceof Error
    ? `${rejection.problem}\n${rejection.cause.message.slice(0, 2000)}`
    : rejection.problem;

/**
 * Checks what an agent submitted against the schema its run declared. The value is kept as
 * submitted. A schema that closes its object turns down keys it does not name; an open one keeps
 * them.
 */
export const checkOutput = Effect.fn("runOutput.checkOutput")(function* (
  schema: OutputSchema,
  json: string,
) {
  const parsed = Result.try(() => JSON.parse(json) as Schema.Json);
  if (Result.isFailure(parsed)) {
    return Result.fail<OutputRejection>({ problem: "`json` is not valid JSON text." });
  }
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) {
    return Result.fail<OutputRejection>({
      problem: "The output schema is not a usable JSON Schema.",
    });
  }
  const outputSchema = compiled.success;
  const decoded = yield* Schema.decodeEffect(outputSchema)(parsed.success, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(Effect.result);
  return Result.isFailure(decoded)
    ? Result.fail<OutputRejection>({
        problem: "The result does not match the schema.",
        cause: decoded.failure,
      })
    : Result.succeed(parsed.success);
});

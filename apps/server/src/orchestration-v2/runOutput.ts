import { parseGoalCommand } from "@t3tools/contracts";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { allowsNativeMessageCommand } from "./CommandPolicy.ts";

type OutputSchema = Readonly<Record<string, Schema.Json>>;
type OutputMessage = Parameters<typeof allowsNativeMessageCommand>[0];

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
export const isProviderCommand = (message: OutputMessage): boolean =>
  allowsNativeMessageCommand(message) &&
  (message.attachments?.length ?? 0) === 0 &&
  (["/compact", "/logout"].includes(message.text.trim().toLowerCase()) ||
    parseGoalCommand(message) !== null);

/** Why a message cannot be asked for a result under this schema, or null when it can. */
export const outputRequestProblem = (schema: OutputSchema, message: OutputMessage): string | null =>
  isProviderCommand(message)
    ? "A command cannot be asked for a result. Ask for it in a message."
    : outputSchemaProblem(schema);

/** Appended to the turn's prompt: the agent learns the shape and how to hand the result back. */
export const outputInstructions = (schema: OutputSchema): string =>
  [
    "A program reads the result of this turn, not a person.",
    "When the work is done, call the `t3_submit_output` tool once with `json` set to JSON text matching this JSON Schema:",
    JSON.stringify(schema),
    "If you could not finish, still submit, with the fields that say so. A rejected submission names what did not fit: correct it and submit again.",
  ].join("\n");

/** Why a submission was turned down. What did not fit is in `cause`, never in the problem. */
export interface OutputRejection {
  readonly problem: string;
  readonly cause?: unknown;
}

/** The rejection as told to whoever wrote the value: the problem, then what in it did not fit. */
export const rejectionText = (rejection: OutputRejection): string => {
  if (!(rejection.cause instanceof Error)) return rejection.problem;
  const { message } = rejection.cause;
  return `${rejection.problem}\n${message.slice(0, splitsSurrogatePair(message, 2000) ? 1999 : 2000)}`;
};

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

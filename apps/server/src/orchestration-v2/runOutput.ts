import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

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
export const outputSchemaProblem = (schema: OutputSchema): string | null =>
  JSON.stringify(schema).length > MAX_SCHEMA_CHARS
    ? `The output schema is larger than ${MAX_SCHEMA_CHARS} characters.`
    : Result.isFailure(compile(schema))
      ? "The output schema is not a usable JSON Schema."
      : null;

/** Appended to the turn's prompt: the agent learns the shape and how to hand the result back. */
export const outputInstructions = (schema: OutputSchema): string =>
  [
    "A program reads the result of this turn, not a person.",
    "When the work is done, call the `t3_submit_output` tool once with `json` set to JSON text matching this JSON Schema:",
    JSON.stringify(schema),
    "If you could not finish, still submit, with the fields that say so. A rejected submission names what did not fit: correct it and submit again.",
  ].join("\n");

/**
 * Checks what an agent submitted against the schema its run declared. The value is kept as
 * submitted: decoding drops keys the schema does not name, and the caller asked for the agent's data.
 */
export const checkOutput = Effect.fn("runOutput.checkOutput")(function* (
  schema: OutputSchema,
  json: string,
) {
  const parsed = Result.try(() => JSON.parse(json) as Schema.Json);
  if (Result.isFailure(parsed)) {
    return Result.fail("`json` is not valid JSON text.");
  }
  const compiled = compile(schema);
  if (Result.isFailure(compiled)) {
    return Result.fail("The output schema is not a usable JSON Schema.");
  }
  const outputSchema = compiled.success;
  const decoded = yield* Schema.decodeEffect(outputSchema)(parsed.success, {
    errors: "all",
  }).pipe(Effect.result);
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure.message.slice(0, 2000))
    : Result.succeed(parsed.success);
});

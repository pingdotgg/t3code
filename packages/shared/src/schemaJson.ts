import { Cause, Exit, Result, Schema, SchemaIssue } from "effect";

export type SchemaJsonDecodePhase = "json" | "schema";

export interface SchemaJsonDecodeFailure {
  readonly phase: SchemaJsonDecodePhase;
  readonly cause: Cause.Cause<Schema.SchemaError>;
}

export const parseJsonResult = (input: unknown): Result.Result<unknown, string> => {
  if (typeof input !== "string") return Result.fail("Expected string");
  try {
    return Result.succeed(JSON.parse(input));
  } catch (e) {
    return Result.fail(e instanceof Error ? e.message : String(e));
  }
};

export const decodeJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeExit(Schema.fromJsonString(schema));
  return (input: string) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const decodeUnknownJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownExit(schema);
  return (input: unknown) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const formatSchemaError = (cause: Cause.Cause<Schema.SchemaError>) => {
  const squashed = Cause.squash(cause);
  return Schema.isSchemaError(squashed)
    ? SchemaIssue.makeFormatterDefault()(squashed.issue)
    : Cause.pretty(cause);
};

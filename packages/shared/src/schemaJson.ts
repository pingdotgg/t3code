import { Cause, Exit, Result, Schema } from "effect";

export type SchemaJsonDecodePhase = "json" | "schema";

export interface SchemaJsonDecodeFailure {
  readonly phase: SchemaJsonDecodePhase;
  readonly cause: Cause.Cause<Schema.SchemaError>;
}

const decodeUnknownJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const decodeJsonString = <S extends Schema.Top>(schema: S) => {
  const decodeSchema = Schema.decodeUnknownExit(schema as never);

  return (input: unknown): Result.Result<Schema.Schema.Type<S>, SchemaJsonDecodeFailure> => {
    const parsed = decodeUnknownJson(input);
    if (Exit.isFailure(parsed)) {
      return Result.fail({
        phase: "json" as const,
        cause: parsed.cause,
      });
    }

    const decoded = decodeSchema(parsed.value);
    if (Exit.isFailure(decoded)) {
      return Result.fail({
        phase: "schema" as const,
        cause: decoded.cause,
      });
    }

    return Result.succeed(decoded.value);
  };
};

export const encodeJsonStringEffect =
  <S extends Schema.Top>(schema: S) =>
  (input: unknown) =>
    Schema.encodeEffect(Schema.fromJsonString(schema as never) as never)(input as never);

export function formatJsonDecodeFailure(failure: SchemaJsonDecodeFailure): string {
  return `${failure.phase === "json" ? "Invalid JSON" : "Schema validation failed"}: ${Cause.pretty(failure.cause)}`;
}

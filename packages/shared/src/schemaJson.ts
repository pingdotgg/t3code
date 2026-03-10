import { Cause, Exit, Schema } from "effect";

export type SchemaJsonDecodePhase = "json" | "schema";

export interface SchemaJsonDecodeFailure {
  readonly phase: SchemaJsonDecodePhase;
  readonly cause: Cause.Cause<Schema.SchemaError>;
}

export type SchemaJsonDecodeResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly failure: SchemaJsonDecodeFailure };

const decodeUnknownJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const decodeJsonString = <S extends Schema.Top>(schema: S) => {
  const decodeSchema = Schema.decodeUnknownExit(schema as never);

  return (input: unknown): SchemaJsonDecodeResult<Schema.Schema.Type<S>> => {
    const parsed = decodeUnknownJson(input);
    if (Exit.isFailure(parsed)) {
      return {
        _tag: "Failure",
        failure: {
          phase: "json",
          cause: parsed.cause,
        },
      };
    }

    const decoded = decodeSchema(parsed.value);
    if (Exit.isFailure(decoded)) {
      return {
        _tag: "Failure",
        failure: {
          phase: "schema",
          cause: decoded.cause,
        },
      };
    }

    return {
      _tag: "Success",
      value: decoded.value,
    };
  };
};

export const encodeJsonStringEffect = <S extends Schema.Top>(schema: S) =>
  ((input: unknown) =>
    Schema.encodeEffect(Schema.fromJsonString(schema as never) as never)(input as never));

export function formatJsonDecodeFailure(failure: SchemaJsonDecodeFailure): string {
  return `${failure.phase === "json" ? "Invalid JSON" : "Schema validation failed"}: ${Cause.pretty(failure.cause)}`;
}

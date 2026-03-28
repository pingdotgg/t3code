import {
  Cause,
  Effect,
  Exit,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

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
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
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

/**
 * A `Getter` that parses a lenient JSON string (tolerating trailing commas
 * and JS-style comments) into an unknown value.
 *
 * Mirrors `SchemaGetter.parseJson()` but uses `parseLenientJson` instead
 * of `JSON.parse`.
 */
const parseLenientJsonGetter = SchemaGetter.onSome((input: string) =>
  Effect.try({
    try: () => {
      // Strip single-line comments — alternation preserves quoted strings.
      let stripped = input.replace(
        /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
        (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
      );

      // Strip multi-line comments.
      stripped = stripped.replace(
        /("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g,
        (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
      );

      // Strip trailing commas before `}` or `]`.
      stripped = stripped.replace(/,(\s*[}\]])/g, "$1");

      return Option.some(JSON.parse(stripped));
    },
    catch: (e) => new SchemaIssue.InvalidValue(Option.some(input), { message: String(e) }),
  }),
);

/**
 * Schema transformation: lenient JSONC string ↔ unknown.
 *
 * Same API as `SchemaTransformation.fromJsonString`, but the decode side
 * strips trailing commas and JS-style comments before parsing.
 * Encoding produces strict JSON via `JSON.stringify`.
 */
export const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

/**
 * Build a schema that decodes a lenient JSON string into `A`.
 *
 * Drop-in replacement for `Schema.fromJsonString(schema)` that tolerates
 * trailing commas and comments in the input.
 */
export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

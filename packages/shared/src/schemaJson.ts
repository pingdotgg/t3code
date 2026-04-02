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

const schemaDescriptionCache = new WeakMap<object, string | undefined>();

const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);

export const encodePrettyJsonEffect = <S extends Schema.Top>(schema: S) =>
  Schema.encodeEffect(
    Schema.fromJsonString(schema).pipe(
      Schema.encode({
        decode: PrettyJsonString,
        encode: PrettyJsonString,
      }),
    ),
  );

export const formatSchemaError = (cause: Cause.Cause<Schema.SchemaError>) => {
  const squashed = Cause.squash(cause);
  return Schema.isSchemaError(squashed)
    ? SchemaIssue.makeFormatterDefault()(squashed.issue)
    : Cause.pretty(cause);
};

function hoistJsonSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(hoistJsonSchemaDescriptions);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, hoistJsonSchemaDescriptions(entry)]),
  ) as Record<string, unknown>;

  if (typeof record.description !== "string") {
    const candidates = ["allOf", "anyOf", "oneOf"]
      .flatMap((key) => (Array.isArray(record[key]) ? (record[key] as ReadonlyArray<unknown>) : []))
      .filter((candidate): candidate is Record<string, unknown> => {
        return !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
      });

    const description = candidates.find(
      (candidate) =>
        typeof candidate.description === "string" &&
        !(candidate.type === "null" && Object.keys(candidate).length <= 1),
    )?.description;

    if (typeof description === "string") {
      record.description = description;
    }
  }

  return record;
}

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export const toJsonSchemaObject = (schema: Schema.Top): unknown => {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return hoistJsonSchemaDescriptions({ ...document.schema, $defs: document.definitions });
  }
  return hoistJsonSchemaDescriptions(document.schema);
};

export const getSchemaDescription = (schema: Schema.Top): string | undefined => {
  if (schema && typeof schema === "object") {
    const cached = schemaDescriptionCache.get(schema);
    if (cached !== undefined || schemaDescriptionCache.has(schema)) {
      return cached;
    }
  }

  const jsonSchema = toJsonSchemaObject(schema);
  const description =
    jsonSchema && typeof jsonSchema === "object" && !Array.isArray(jsonSchema)
      ? typeof (jsonSchema as Record<string, unknown>).description === "string"
        ? ((jsonSchema as Record<string, unknown>).description as string)
        : undefined
      : undefined;

  if (schema && typeof schema === "object") {
    schemaDescriptionCache.set(schema, description);
  }

  return description;
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

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

const MAX_SCHEMA_DIAGNOSTIC_ISSUES = 8;
const MAX_SCHEMA_DIAGNOSTIC_PATH_SEGMENTS = 16;
const MAX_SCHEMA_DIAGNOSTIC_PATH_SEGMENT_LENGTH = 64;
const MAX_SCHEMA_DIAGNOSTIC_LENGTH = 2_048;

interface SchemaDiagnosticIssue {
  readonly message: string;
  readonly path: ReadonlyArray<PropertyKey>;
}

// Schema's default formatter includes actual values. These diagnostics cross
// process and UI boundaries, so retain only issue kinds and bounded paths.

function truncateDiagnostic(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function formatDiagnosticPathSegment(key: PropertyKey): string {
  if (typeof key === "number") {
    return `[${key}]`;
  }
  const value = truncateDiagnostic(
    typeof key === "symbol" ? String(key) : key,
    MAX_SCHEMA_DIAGNOSTIC_PATH_SEGMENT_LENGTH,
  );
  return `[${JSON.stringify(value)}]`;
}

function formatDiagnosticIssue(issue: SchemaDiagnosticIssue): string {
  if (issue.path.length === 0) {
    return issue.message;
  }
  const path = issue.path
    .slice(0, MAX_SCHEMA_DIAGNOSTIC_PATH_SEGMENTS)
    .map(formatDiagnosticPathSegment)
    .join("");
  const suffix = issue.path.length > MAX_SCHEMA_DIAGNOSTIC_PATH_SEGMENTS ? "[...]" : "";
  return `${issue.message}\n  at ${path}${suffix}`;
}

function schemaDiagnosticMessage(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "InvalidType":
      return "Invalid type";
    case "InvalidValue":
    case "Filter":
    case "AnyOf":
    case "Encoding":
    case "Pointer":
    case "Composite":
      return "Invalid value";
    case "MissingKey":
      return "Missing key";
    case "UnexpectedKey":
      return "Unexpected key";
    case "Forbidden":
      return "Forbidden operation";
    case "OneOf":
      return "Expected exactly one schema member to match";
  }
}

function collectSchemaDiagnosticIssues(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  diagnostics: Array<SchemaDiagnosticIssue>,
): number {
  switch (issue._tag) {
    case "Encoding":
      return collectSchemaDiagnosticIssues(issue.issue, path, diagnostics);
    case "Filter":
      if (issue.issue._tag !== "InvalidValue") {
        return collectSchemaDiagnosticIssues(issue.issue, path, diagnostics);
      }
      break;
    case "Pointer":
      return collectSchemaDiagnosticIssues(issue.issue, [...path, ...issue.path], diagnostics);
    case "Composite":
      return issue.issues.reduce(
        (count, issue) => count + collectSchemaDiagnosticIssues(issue, path, diagnostics),
        0,
      );
    case "AnyOf":
      if (issue.issues.length > 0) {
        return issue.issues.reduce(
          (count, issue) => count + collectSchemaDiagnosticIssues(issue, path, diagnostics),
          0,
        );
      }
      break;
  }

  if (diagnostics.length < MAX_SCHEMA_DIAGNOSTIC_ISSUES) {
    diagnostics.push({ message: schemaDiagnosticMessage(issue), path });
  }
  return 1;
}

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
  const issues: Array<SchemaDiagnosticIssue> = [];
  let issueCount = 0;
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    switch (reason._tag) {
      case "Fail":
        failureCount += 1;
        if (Schema.isSchemaError(reason.error)) {
          issueCount += collectSchemaDiagnosticIssues(reason.error.issue, [], issues);
        }
        break;
      case "Die":
        defectCount += 1;
        break;
      case "Interrupt":
        interruptionCount += 1;
        break;
    }
  }

  if (issues.length === 0) {
    return `Schema validation failed (failureCount=${failureCount}, defectCount=${defectCount}, interruptionCount=${interruptionCount}).`;
  }

  const omittedIssueCount = issueCount - issues.length;
  const formatted = issues.map(formatDiagnosticIssue).join("\n");
  if (omittedIssueCount === 0) {
    return truncateDiagnostic(formatted, MAX_SCHEMA_DIAGNOSTIC_LENGTH);
  }
  const suffix = `\n... and ${omittedIssueCount} more issue(s)`;
  return truncateDiagnostic(formatted, MAX_SCHEMA_DIAGNOSTIC_LENGTH - suffix.length) + suffix;
};

/**
 * A `Getter` that parses a lenient JSON string (tolerating trailing commas
 * and JS-style comments) into an unknown value.
 *
 * Mirrors `SchemaGetter.parseJson()` but strips JSONC syntax before parsing.
 */
const decodeJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);

const parseLenientJsonGetter = SchemaGetter.onSome((input: string) => {
  // Strip single-line comments - alternation preserves quoted strings.
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

  return decodeJsonString(stripped).pipe(
    Effect.map(Option.some),
    Effect.mapError((error) => error.issue),
  );
});

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

export const prettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);

/**
 * Build a schema that decodes a lenient JSON string into `A`.
 *
 * Drop-in replacement for `Schema.fromJsonString(schema)` that tolerates
 * trailing commas and comments in the input.
 */
export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

/**
 * Build a JSON string schema that encodes with stable 2-space formatting.
 *
 * Decode behavior matches `Schema.fromJsonString(schema)`. Encode behavior
 * keeps the transformation schema-based while preserving human-readable JSON.
 */
export const fromJsonStringPretty = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(schema).pipe(
    Schema.encode({
      decode: prettyJsonString,
      encode: prettyJsonString,
    }),
  );

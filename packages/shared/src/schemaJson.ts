import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const parseLenientJsonGetter = SchemaGetter.transformEffect((input: string) => {
  // Match comments together so URLs stay inside blocks; whitespace keeps adjacent tokens apart.
  let stripped = input.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : " "),
  );

  stripped = stripped.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (match, stringLiteral: string | undefined, bracket: string | undefined) =>
      stringLiteral ? match : (bracket ?? ""),
  );

  return decodeJsonString(stripped).pipe(Effect.mapError((error) => error.issue));
});

const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

const prettyJsonString = SchemaGetter.parseJson<string>().pipe(
  SchemaGetter.compose(SchemaGetter.stringifyJson({ space: 2 })),
);

export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

/** Trailing commas are tolerated downstream, so parse checks have to tolerate them too. */
function parsesAsJson(candidate: string): boolean {
  try {
    JSON.parse(candidate.replace(/,\s*([}\]])/gu, "$1"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk one JSON object, reporting where it ends and what was still open there.
 *
 * `end` is the index just past the closing brace when the object completes. When it does not —
 * the reply was cut off mid-answer — `end` is null and `stack` holds the brackets still open,
 * which is what the repair below needs to close.
 */
function scanJsonObject(text: string, start: number) {
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaping = false;
  // Just past the last bracket that closed inside the object, which is the last point a
  // truncated reply can be cut back to without keeping a fragment.
  let lastComplete: number | null = null;
  // The brackets open at that cut point, which are the ones the repair has to close. Taking the
  // stack as it stands at the end instead would also close brackets opened by the fragment being
  // discarded.
  let lastCompleteStack: ReadonlyArray<"}" | "]"> = [];

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      if (stack.length === 0) return { end: index + 1, stack, lastComplete };
      // Only a closed bracket is a safe place to cut. A comma is not: inside a half-written
      // entry it sits between that entry's own fields, and cutting there would keep a fragment
      // missing whatever the reply had not reached yet.
      lastComplete = index + 1;
      lastCompleteStack = [...stack];
    }
  }
  return { end: null, stack: lastCompleteStack, lastComplete };
}

/**
 * The JSON object inside an agent's reply.
 *
 * Agents do not always answer with only the object asked for: some wrap it in prose or a fenced
 * block, and a long answer — a ranking over a whole backlog, say — can simply stop partway. The
 * first brace in the text is therefore not reliably the start of the answer, and the text after
 * it is not reliably a complete object.
 *
 * So every brace is tried until one yields something that parses, and a reply that was cut off is
 * closed back to its last complete entry rather than thrown away — the entries that did arrive
 * are still worth having. Falls back to the original span when nothing parses, which leaves the
 * caller's own error to describe the failure.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  if (trimmed.length === 0) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) return trimmed;

  for (let start = firstBrace; start >= 0; start = trimmed.indexOf("{", start + 1)) {
    const scan = scanJsonObject(trimmed, start);
    if (scan.end !== null) {
      const candidate = trimmed.slice(start, scan.end);
      if (parsesAsJson(candidate)) return candidate;
      continue;
    }
    // Cut off: keep what completed and close what is still open.
    if (scan.lastComplete !== null) {
      const repaired =
        trimmed.slice(start, scan.lastComplete).replace(/,\s*$/u, "") +
        scan.stack.toReversed().join("");
      if (parsesAsJson(repaired)) return repaired;
    }
  }

  return trimmed.slice(firstBrace);
}

export const fromJsonStringPretty = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(schema).pipe(
    Schema.encode({
      decode: prettyJsonString,
      encode: prettyJsonString,
    }),
  );

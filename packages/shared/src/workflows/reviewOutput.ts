export type ReviewOutputJson =
  | { readonly status: "decoded"; readonly value: unknown }
  | { readonly status: "invalid"; readonly issue: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObjectEnd(value: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

/**
 * Reviewer output is a single JSON object, but providers routinely wrap it in
 * prose. Recover the one embedded object when the whole payload is not JSON.
 */
export function extractReviewOutputJson(output: string): ReviewOutputJson {
  try {
    return { status: "decoded", value: JSON.parse(output) };
  } catch {
    const candidates: unknown[] = [];
    for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
      const end = jsonObjectEnd(output, start);
      if (end === null) continue;
      try {
        candidates.push(JSON.parse(output.slice(start, end + 1)));
        start = end;
      } catch {
        // An invalid outer object can contain a valid embedded review object.
      }
    }
    if (candidates.length === 1) {
      return { status: "decoded", value: candidates[0] };
    }
    return {
      status: "invalid",
      issue:
        candidates.length === 0
          ? "Reviewer output was not valid JSON."
          : "Reviewer output contained multiple JSON objects.",
    };
  }
}

/**
 * Identifies assistant text that is the reviewer's structured output, so the
 * transcript can render the findings card instead of the raw JSON.
 */
export function isReviewOutputText(output: string): boolean {
  if (!output.includes('"overall_correctness"')) return false;
  const decoded = extractReviewOutputJson(output);
  return (
    decoded.status === "decoded" &&
    isRecord(decoded.value) &&
    Array.isArray(decoded.value.findings) &&
    typeof decoded.value.overall_correctness === "string"
  );
}

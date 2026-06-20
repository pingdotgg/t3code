import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeJsonResult,
  extractJsonObject,
  formatSchemaError,
  fromLenientJson,
} from "./schemaJson.ts";

const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("schemaJson helpers", () => {
  it("extracts a balanced JSON object from surrounding text", () => {
    expect(
      extractJsonObject(`Sure, here is the JSON:
\`\`\`json
{
  "subject": "Update README",
  "body": ""
}
\`\`\`
Done.`),
    ).toBe(`{
  "subject": "Update README",
  "body": ""
}`);
  });

  it("ignores braces inside strings while finding the object boundary", () => {
    expect(
      extractJsonObject('prefix {"message":"literal } brace","nested":{"ok":true}} suffix'),
    ).toBe('{"message":"literal } brace","nested":{"ok":true}}');
  });

  it("returns trimmed input when no JSON object starts", () => {
    expect(extractJsonObject("  no structured output  ")).toBe("no structured output");
  });

  it("decodes JSON with comments and trailing commas", () => {
    expect(
      decodeLenientJson(`{
        // Comments are valid in settings files.
        "enabled": true,
        "values": [1, 2,],
      }`),
    ).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("rejects malformed JSON after lenient preprocessing", () => {
    expect(() => decodeLenientJson('{ "enabled": true,, }')).toThrow();
  });

  it("formats schema failures with paths without exposing invalid values", () => {
    const decodeCredential = decodeJsonResult(Schema.Struct({ token: Schema.Number }));
    const decoded = decodeCredential('{"token":"credential=secret-value"}');

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(formatSchemaError(decoded.failure)).toBe('Invalid type\n  at ["token"]');
    }
  });

  it("preserves nested paths reported by schema filters", () => {
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({
          path: ["session", "token"],
          issue: "credential is invalid",
        })),
      ),
    );
    const decoded = decode('"credential=secret-value"');

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      const diagnostic = formatSchemaError(decoded.failure);
      expect(diagnostic).toBe('Invalid value\n  at ["session"]["token"]');
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("does not expose malformed lenient JSON input in diagnostics", () => {
    const decode = Schema.decodeUnknownExit(fromLenientJson(Schema.Unknown));
    const exit = decode('{"token":"credential=secret-value",,}');

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const diagnostic = formatSchemaError(exit.cause);
      expect(diagnostic).toBe("Invalid value");
      expect(diagnostic).not.toContain("credential=secret-value");
    }
  });

  it("summarizes unexpected defects without serializing their messages", () => {
    const diagnostic = formatSchemaError(Cause.die(new Error("credential=secret-value")));

    expect(diagnostic).toBe(
      "Schema validation failed (failureCount=0, defectCount=1, interruptionCount=0).",
    );
  });

  it("bounds the number of formatted schema issues", () => {
    const decode = decodeJsonResult(Schema.Struct({ token: Schema.Number }));
    const failures: Array<Cause.Cause<Schema.SchemaError>> = [];
    for (let index = 0; index < 10; index += 1) {
      const decoded = decode(`{"token":"credential=secret-value-${index}"}`);
      if (Result.isFailure(decoded)) {
        failures.push(decoded.failure);
      }
    }

    const cause = Cause.fromReasons(failures.flatMap((cause) => cause.reasons));
    const diagnostic = formatSchemaError(cause);
    expect(diagnostic.match(/Invalid type/g)).toHaveLength(8);
    expect(diagnostic).toContain("... and 2 more issue(s)");
  });

  it("retains the omitted issue count when bounding long diagnostics", () => {
    const longPath = Array.from({ length: 16 }, (_, index) => `${index}-${"segment".repeat(16)}`);
    const decode = decodeJsonResult(
      Schema.String.check(
        Schema.makeFilter(() => ({ path: longPath, issue: "credential is invalid" })),
      ),
    );
    const failures: Array<Cause.Cause<Schema.SchemaError>> = [];
    for (let index = 0; index < 10; index += 1) {
      const decoded = decode(`"credential=secret-value-${index}"`);
      if (Result.isFailure(decoded)) {
        failures.push(decoded.failure);
      }
    }

    const cause = Cause.fromReasons(failures.flatMap((cause) => cause.reasons));
    const diagnostic = formatSchemaError(cause);
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
    expect(diagnostic.endsWith("\n... and 2 more issue(s)")).toBe(true);
  });
});

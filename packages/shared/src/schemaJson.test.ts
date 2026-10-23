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

  it("decodes JSON with comments and trailing commas", () => {
    expect(
      decodeLenientJson(`{
        // Comments are valid in settings files.
        "enabled": /* See "https://example.com/config" // still in the block */ true,
        "values": [1, 2,],
      }`),
    ).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("preserves comment markers and commas before brackets inside string values", () => {
    expect(decodeLenientJson('"1/* https://example.com */2"')).toBe("1/* https://example.com */2");
    expect(decodeLenientJson('{"note":"a,]"}')).toEqual({ note: "a,]" });
    expect(decodeLenientJson('{"list":["x,}"]}')).toEqual({ list: ["x,}"] });
    expect(decodeLenientJson('{"values":[1, 2,],}')).toEqual({ values: [1, 2] });
  });

  it("formats schema failures with paths without exposing invalid values", () => {
    const decodeCredential = decodeJsonResult(Schema.Struct({ token: Schema.Number }));
    const decoded = decodeCredential('{"token":"credential=secret-value"}');

    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(formatSchemaError(decoded.failure)).toBe('Invalid type\n  at ["token"]');
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
});

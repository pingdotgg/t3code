import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { extractJsonObject, fromLenientJson } from "./schemaJson.ts";

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

  it.each(["\n", "\r\n", "\r"])(
    "decodes comments and trailing commas with %j line endings",
    (eol) => {
      expect(
        decodeLenientJson(
          `{
        // Comments are valid in settings files.
        "enabled": /* See "https://example.com/config" // still in the block */ true,
        "values": [1, 2,],
      }`.replaceAll("\n", eol),
        ),
      ).toEqual({
        enabled: true,
        values: [1, 2],
      });
    },
  );

  it("preserves comment markers and commas before brackets inside string values", () => {
    expect(decodeLenientJson('"1/* https://example.com */2"')).toBe("1/* https://example.com */2");
    expect(decodeLenientJson('{"note":"a,]"}')).toEqual({ note: "a,]" });
    expect(decodeLenientJson('{"list":["x,}"]}')).toEqual({ list: ["x,}"] });
    expect(decodeLenientJson('{"values":[1, 2,],}')).toEqual({ values: [1, 2] });
  });

  it("keeps properties after CR-terminated comments in mixed line endings", () => {
    expect(decodeLenientJson('{\n"enabled":true,// comment\r"values":[1,2],\n}')).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });
});

describe("extractJsonObject with imperfect agent replies", () => {
  it("skips a brace in prose and finds the answer after it", () => {
    const raw =
      'Here is the result. I used {curly} loosely.\n{"rankings":[{"number":7,"score":90}]}';

    expect(JSON.parse(extractJsonObject(raw))).toEqual({
      rankings: [{ number: 7, score: 90 }],
    });
  });

  it("unwraps a fenced block", () => {
    const raw = '```json\n{"rankings":[{"number":1,"score":50}]}\n```';

    expect(JSON.parse(extractJsonObject(raw))).toEqual({ rankings: [{ number: 1, score: 50 }] });
  });

  it("keeps the entries a cut-off reply did deliver", () => {
    // A long ranking that stopped mid-entry: the first two are whole and worth keeping.
    const raw = '{"rankings":[{"number":1,"score":90},{"number":2,"score":80},{"number":3,"sco';

    expect(JSON.parse(extractJsonObject(raw))).toEqual({
      rankings: [
        { number: 1, score: 90 },
        { number: 2, score: 80 },
      ],
    });
  });

  it("closes a reply cut off between entries", () => {
    const raw = '{"rankings":[{"number":1,"score":90},';

    expect(JSON.parse(extractJsonObject(raw))).toEqual({ rankings: [{ number: 1, score: 90 }] });
  });

  it("leaves an unparseable reply to the caller's own error", () => {
    expect(extractJsonObject("{not json at all")).toBe("{not json at all");
  });
});

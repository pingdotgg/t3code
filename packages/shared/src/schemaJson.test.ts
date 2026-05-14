import { describe, expect, it } from "vitest";

import { extractJsonObject } from "./schemaJson.ts";

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
});

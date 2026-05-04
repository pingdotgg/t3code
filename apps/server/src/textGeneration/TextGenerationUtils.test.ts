import { describe, expect, it } from "vitest";

import { extractJsonObject, extractJsonValueFromText } from "./TextGenerationUtils.ts";

describe("extractJsonObject", () => {
  it("extracts the first balanced object from surrounding text", () => {
    expect(extractJsonObject('prefix {"title":"hello","items":[1,2]} suffix')).toBe(
      '{"title":"hello","items":[1,2]}',
    );
  });

  it("preserves the legacy partial tail fallback for unterminated objects", () => {
    expect(extractJsonObject('prefix {"title":"hello"')).toBe('{"title":"hello"');
  });

  it("returns the trimmed input when no object exists", () => {
    expect(extractJsonObject("  no json here  ")).toBe("no json here");
  });
});

describe("extractJsonValueFromText", () => {
  it("parses a fenced JSON array from model output", () => {
    expect(extractJsonValueFromText('```json\n[1, {"title":"hello"}]\n```')).toEqual([
      1,
      { title: "hello" },
    ]);
  });

  it("parses the first balanced JSON value from surrounding prose", () => {
    expect(
      extractJsonValueFromText('Result: {"title":"hello","items":[1,2]} trailing text'),
    ).toEqual({
      title: "hello",
      items: [1, 2],
    });
  });
});

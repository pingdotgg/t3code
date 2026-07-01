import { describe, expect, it } from "vitest";

import { extractJsonObject } from "./Utils.ts";

describe("extractJsonObject", () => {
  it("returns a plain JSON object unchanged", () => {
    const raw = '{"subject":"Add login","body":""}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("unwraps a fenced JSON code block", () => {
    const raw = '```json\n{"subject":"ok","body":"x"}\n```';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ subject: "ok", body: "x" });
  });

  it("ignores decoy braces in prose before the real object", () => {
    const raw =
      "Here is the commit. It adds `login() {}` to auth.\n" +
      '```json\n{"subject":"Add login","body":""}\n```';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ subject: "Add login", body: "" });
  });

  it("ignores an empty object literal mentioned in prose", () => {
    const raw = 'The diff changes `const x = {}` config.\n{"subject":"S","body":"B"}';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({ subject: "S", body: "B" });
  });

  it("does not treat braces inside string values as object boundaries", () => {
    const raw = '{"subject":"Refactor {config} handling","body":"uses {} maps"}';
    expect(JSON.parse(extractJsonObject(raw))).toEqual({
      subject: "Refactor {config} handling",
      body: "uses {} maps",
    });
  });

  it("returns the first balanced span when nothing parses so callers surface a schema error", () => {
    const raw = "prefix {not valid json";
    expect(extractJsonObject(raw)).toBe("{not valid json");
  });

  it("returns empty input unchanged", () => {
    expect(extractJsonObject("   ")).toBe("");
  });
});

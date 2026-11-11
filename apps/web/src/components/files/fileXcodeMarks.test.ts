import { describe, expect, it } from "vite-plus/test";

import { collectXcodeMarks } from "./fileXcodeMarks";

describe("collectXcodeMarks", () => {
  it("returns no marks for empty input", () => {
    expect(collectXcodeMarks(null)).toEqual([]);
    expect(collectXcodeMarks(undefined)).toEqual([]);
    expect(collectXcodeMarks("")).toEqual([]);
  });

  it("parses source landmarks", () => {
    expect(collectXcodeMarks("// MARK: - Lifecycle\n")).toEqual([
      { line: 1, kind: "mark", title: "Lifecycle", separator: true },
    ]);
  });

  it("skips non C-family paths", () => {
    expect(collectXcodeMarks("// MARK: - Lifecycle\n", "app.ts")).toEqual([]);
    expect(collectXcodeMarks("// MARK: - Lifecycle\n", "Foo.swift")).toEqual([
      { line: 1, kind: "mark", title: "Lifecycle", separator: true },
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { parseXcodeMarks, pathSupportsXcodeMarks, xcodeMarkMenuLabel } from "./xcodeMarks.ts";

describe("parseXcodeMarks", () => {
  it("parses MARK, TODO, FIXME, and #pragma mark with optional separators", () => {
    expect(
      parseXcodeMarks(
        [
          "// preamble",
          "// MARK: Setup",
          "// MARK: - Actions",
          "// MARK: -",
          "//TODO: fill in",
          "  // FIXME: broken",
          "/* MARK: Block */",
          "#pragma mark Legacy",
          "#pragma mark - Divider",
          "/// MARK: Doc",
          "console.log('// MARK: not a mark')",
        ].join("\n"),
      ),
    ).toEqual([
      { line: 2, kind: "mark", title: "Setup", separator: false },
      { line: 3, kind: "mark", title: "Actions", separator: true },
      { line: 4, kind: "mark", title: "", separator: true },
      { line: 5, kind: "todo", title: "fill in", separator: false },
      { line: 6, kind: "fixme", title: "broken", separator: false },
      { line: 7, kind: "mark", title: "Block", separator: false },
      { line: 8, kind: "mark", title: "Legacy", separator: false },
      { line: 9, kind: "mark", title: "Divider", separator: true },
      { line: 10, kind: "mark", title: "Doc", separator: false },
    ]);
  });

  it("ignores lowercase labels Xcode would not recognise", () => {
    expect(
      parseXcodeMarks(["// todo: later", "// Mark: Section", "#pragma MARK Legacy"].join("\n")),
    ).toEqual([]);
  });

  it("keeps CR LF line numbers stable", () => {
    expect(parseXcodeMarks("a\r\n// MARK: Mid\r\nb")).toEqual([
      { line: 2, kind: "mark", title: "Mid", separator: false },
    ]);
  });

  it("parses classic Mac CR-only line endings", () => {
    expect(parseXcodeMarks("a\r// MARK: Mid\rb")).toEqual([
      { line: 2, kind: "mark", title: "Mid", separator: false },
    ]);
  });
});

describe("pathSupportsXcodeMarks", () => {
  it("accepts Swift, ObjC, and C-family paths only", () => {
    expect(pathSupportsXcodeMarks("Foo.swift")).toBe(true);
    expect(pathSupportsXcodeMarks("/src/ViewController.m")).toBe(true);
    expect(pathSupportsXcodeMarks("lib\\\\core.HPP")).toBe(true);
    expect(pathSupportsXcodeMarks("app.ts")).toBe(false);
    expect(pathSupportsXcodeMarks("main.go")).toBe(false);
    expect(pathSupportsXcodeMarks("README")).toBe(false);
  });
});

describe("xcodeMarkMenuLabel", () => {
  it("hides separator-only MARK rows and prefixes task marks", () => {
    expect(xcodeMarkMenuLabel({ line: 1, kind: "mark", title: "", separator: true })).toBeNull();
    expect(xcodeMarkMenuLabel({ line: 1, kind: "mark", title: "Setup", separator: true })).toBe(
      "Setup",
    );
    expect(xcodeMarkMenuLabel({ line: 1, kind: "todo", title: "later", separator: false })).toBe(
      "TODO: later",
    );
    expect(xcodeMarkMenuLabel({ line: 1, kind: "fixme", title: "", separator: false })).toBe(
      "FIXME",
    );
  });
});

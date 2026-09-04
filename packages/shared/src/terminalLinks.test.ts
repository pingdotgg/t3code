import { describe, expect, it } from "vite-plus/test";

import {
  extractTerminalLinks,
  resolvePathLinkTarget,
  terminalLinkAtIndex,
} from "./terminalLinks.ts";

describe("terminalLinkAtIndex", () => {
  const line = "Listening on https://example.com/app?tab=1 (press q to quit)";

  it("returns the url when the index falls inside it", () => {
    expect(terminalLinkAtIndex(line, 20)).toEqual({
      kind: "url",
      text: "https://example.com/app?tab=1",
      start: 13,
      end: 42,
    });
  });

  it("returns undefined outside the link span", () => {
    expect(terminalLinkAtIndex(line, 5)).toBeUndefined();
    expect(terminalLinkAtIndex(line, 42)).toBeUndefined();
    expect(terminalLinkAtIndex(line, -1)).toBeUndefined();
    expect(terminalLinkAtIndex(line, line.length)).toBeUndefined();
  });

  it("resolves path links by index", () => {
    const output = "error in src/lib/utils.ts:12:3 near token";
    expect(terminalLinkAtIndex(output, 12)?.text).toBe("src/lib/utils.ts:12:3");
  });

  it("resolves urls joined across soft-wrapped rows", () => {
    // Native surfaces join soft-wrapped rows before lookup, so a URL that
    // spanned two terminal rows arrives as one line.
    const joined = "https://example.com/very/long/path/that/wrapped/around?query=value";
    expect(terminalLinkAtIndex(joined, joined.length - 1)?.text).toBe(joined);
  });

  it("trims a long run of unmatched closing delimiters", () => {
    const suffix = ")".repeat(10_000);
    expect(terminalLinkAtIndex(`https://example.com/path${suffix}`, 10)?.text).toBe(
      "https://example.com/path",
    );
  });
});

describe("resolvePathLinkTarget", () => {
  it.each([
    ["src/main.ts:0", "/workspace/src/main.ts"],
    ["src/main.ts:12:0", "/workspace/src/main.ts:12"],
    ["src/main.ts:0:4", "/workspace/src/main.ts"],
  ])("drops unusable zero positions from %s", (target, expected) => {
    expect(resolvePathLinkTarget(target, "/workspace")).toBe(expected);
  });
});

describe("Hermes compatibility", () => {
  // Mobile runs this module on Hermes, which ships no Array.prototype.toSorted.
  it("extracts links without array methods unavailable in Hermes", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Reflect.deleteProperty(Array.prototype, "toSorted");

    try {
      expect(
        extractTerminalLinks("see src/main.ts:3 and https://example.com/x").map(
          (match) => match.text,
        ),
      ).toEqual(["src/main.ts:3", "https://example.com/x"]);
      expect(terminalLinkAtIndex("open https://example.com/x now", 10)?.text).toBe(
        "https://example.com/x",
      );
    } finally {
      if (descriptor !== undefined) {
        Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
      }
    }
  });
});

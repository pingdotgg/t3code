import { describe, expect, it } from "@effect/vitest";

import { parseIgnoreFile } from "./IgnorePatterns.ts";

const decide = (contents: string, path: string, isFolder = false) =>
  parseIgnoreFile(contents).decide(path, isFolder);

describe("parseIgnoreFile", () => {
  it("lets the last matching pattern decide, including negations", () => {
    expect(decide("*keep*\n!*keep*\n", "sub/keep-link.ts")).toBe("included");
    expect(decide("!*keep*\n*keep*\n", "sub/keep-link.ts")).toBe("ignored");
    expect(decide("# comment\n\nother\n", "keep.ts")).toBeUndefined();
  });

  it("anchors patterns that contain a slash and matches bare names at any depth", () => {
    expect(decide("link", "a/b/link")).toBe("ignored");
    expect(decide("/link", "a/link")).toBeUndefined();
    expect(decide("/link", "link")).toBe("ignored");
    expect(decide("a/link", "x/a/link")).toBeUndefined();
    expect(decide("a/*.ts", "a/b/c.ts")).toBeUndefined();
    expect(decide("link", "blink")).toBeUndefined();
    expect(decide("link", "a/blink")).toBeUndefined();
  });

  it("supports globstars, classes, escapes, and folder-only patterns", () => {
    expect(decide("**/gen/*.ts", "gen/a.ts")).toBe("ignored");
    expect(decide("a/**/b", "a/x/y/b")).toBe("ignored");
    expect(decide("a/**/b", "a/b")).toBe("ignored");
    expect(decide("foo/**/bar", "foo/xbar")).toBeUndefined();
    expect(decide("foo/**/bar", "foo/x/ybar")).toBeUndefined();
    expect(decide("out/**", "out/x/y")).toBe("ignored");
    expect(decide("link-[0-9]", "link-7")).toBe("ignored");
    expect(decide("link-[!0-9]", "link-7")).toBeUndefined();
    expect(decide("link-?", "link-/")).toBeUndefined();
    expect(decide("\\!bang\n\\#hash\nstar\\*", "!bang")).toBe("ignored");
    expect(decide("\\!bang\n\\#hash\nstar\\*", "#hash")).toBe("ignored");
    expect(decide("\\!bang\n\\#hash\nstar\\*", "starx")).toBeUndefined();
    expect(decide("dist/", "dist")).toBeUndefined();
    expect(decide("dist/", "dist", true)).toBe("ignored");
  });

  it("matches adversarial patterns in linear time", () => {
    // A backtracking regex takes seconds to reject this pair; the vitest timeout catches that.
    const pattern = `${"a*".repeat(20)}b\n`;
    expect(decide(pattern, `${"a".repeat(200)}c`)).toBeUndefined();
    expect(decide(pattern.repeat(50), `${"a".repeat(1_000)}c`)).toBeUndefined();
    expect(decide(pattern, `${"a".repeat(200)}b`)).toBe("ignored");
  });

  it("parses unclosed classes in linear time", () => {
    // Rescanning the rest of the line for each `[` stalls for over a minute here; linear takes ms.
    expect(decide("[".repeat(30_000), "[".repeat(30_000))).toBe("ignored");
    expect(decide(`${"[".repeat(30_000)}]`, "x")).toBeUndefined();
    expect(decide("[a][", "a[")).toBe("ignored");
  });
});

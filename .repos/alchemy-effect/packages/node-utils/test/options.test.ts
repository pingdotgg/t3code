import { describe, expect, it } from "bun:test";
import ignore, { isPathValid } from "../src/ignore.ts";

describe("ignore v7.0.5 options and public methods", () => {
  it("adds another Ignore instance", () => {
    const a = ignore().add([".abc/*", "!.abc/d/"]);
    const b = ignore().add(a).add("!.abc/e/");
    const paths = [".abc/a.js", ".abc/d/e.js", ".abc/e/e.js"];

    expect(a.filter(paths)).toEqual([".abc/d/e.js"]);
    expect(b.filter(paths)).toEqual([".abc/d/e.js", ".abc/e/e.js"]);
  });

  it("cannot invoke the instance constructor without new", () => {
    const { constructor } = ignore();
    expect(() => (constructor as () => unknown)()).toThrow();
  });

  it("accepts an Ignore-shaped instance from another module copy", () => {
    const source = ignore().add([".abc/*", "!.abc/d/"]);
    const compatible = {
      _rules: {
        _rules: (source as any)._rules._rules.slice(),
      },
      [Symbol.for("node-ignore")]: true,
    };
    const matcher = ignore()
      .add(compatible as any)
      .add("!.abc/e/");

    expect(matcher.filter([".abc/a.js", ".abc/d/e.js", ".abc/e/e.js"])).toEqual(
      [".abc/d/e.js", ".abc/e/e.js"],
    );
  });

  it("respects ignorecase", () => {
    const matcher = ignore({ ignorecase: false }).add("*.[jJ][pP]g");
    expect(matcher.ignores("a.jpg")).toBe(true);
    expect(matcher.ignores("a.JPg")).toBe(true);
    expect(matcher.ignores("a.JPG")).toBe(false);
  });

  it("respects ignorecase without leaking the compiled-rule cache", () => {
    const rule = "*.[jJ][pP]g";
    expect(ignore({ ignorecase: false }).add(rule).ignores("a.JPG")).toBe(
      false,
    );
    expect(ignore({ ignorecase: true }).add(rule).ignores("a.JPG")).toBe(true);
  });

  it("rejects invalid paths", () => {
    const matcher = ignore();
    expect(() => matcher.ignores("")).toThrow();
    expect(() => matcher.ignores("/a")).toThrow("path.relative");
    expect(() => matcher.filter([""])).toThrow();
    expect(() => [""].filter(matcher.createFilter())).toThrow();
  });

  it("validates paths", () => {
    expect([".", "./foo", "../foo", "/foo", "foo"].filter(isPathValid)).toEqual(
      ["foo"],
    );
  });

  it("returns ignored and unignored state from test", () => {
    const cases: Array<
      [string | string[] | undefined, string, boolean, boolean]
    > = [
      [undefined, "foo", false, false],
      ["bar", "foo", false, false],
      ["!foo", "foo", false, true],
      [["foo", "!foo"], "foo", false, true],
      [["foo", "!foo"], "foo/bar", false, false],
      [["*.js", "!a/a.js"], "a/a.js", false, true],
      ...(process.platform === "win32"
        ? []
        : ([[undefined, "...", false, false]] as Array<
            [undefined, string, boolean, boolean]
          >)),
    ];

    for (const [patterns, path, ignored, unignored] of cases) {
      const matcher = ignore();
      if (patterns) matcher.add(patterns);
      expect(matcher.test(path)).toEqual({ ignored, unignored });
    }
  });

  it("optionally permits relative paths", () => {
    expect(
      ignore({ allowRelativePaths: true }).add("foo").ignores("../foo/bar.js"),
    ).toBe(true);
    expect(() => ignore().ignores("../foo/bar.js")).toThrow("path.relative");
    expect(() => ignore().add("foo").ignores("/foo/bar.js")).toThrow(
      "path.relative",
    );
  });
});

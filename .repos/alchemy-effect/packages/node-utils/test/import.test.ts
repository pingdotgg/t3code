import { describe, expect, it } from "bun:test";
import ignore, { isPathValid } from "../src/ignore.ts";

describe("module exports", () => {
  it("supports the upstream default and named import surface", () => {
    const matcher = ignore().add("*").add(["!*/", "!foo/bar"]);

    expect(matcher.createFilter()("a")).toBe(false);
    expect(matcher.filter(["a", "a/b", "foo/bar"])).toEqual(["foo/bar"]);
    expect(matcher.ignores("a")).toBe(true);
    expect(isPathValid("./foo")).toBe(false);
    matcher.add({ pattern: "foo/*", mark: "10" });
    expect(matcher.checkIgnore("foo/").rule?.mark).toBe("10");
  });
});

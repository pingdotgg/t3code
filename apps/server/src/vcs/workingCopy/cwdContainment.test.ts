import { assert, describe, it } from "@effect/vitest";

import { findContainingRoot, isPathContained, normalizeContainmentPath } from "./cwdContainment.ts";

describe("normalizeContainmentPath", () => {
  it("unifies separators so a Windows root and a posix cwd still compare", () => {
    assert.strictEqual(normalizeContainmentPath("C:\\Users\\me\\proj"), "C:/Users/me/proj");
  });

  it("drops a trailing separator but keeps a bare root", () => {
    assert.strictEqual(normalizeContainmentPath("/a/b/"), "/a/b");
    assert.strictEqual(normalizeContainmentPath("/a/b///"), "/a/b");
    assert.strictEqual(normalizeContainmentPath("/"), "/");
  });
});

describe("isPathContained", () => {
  it("accepts the root itself and anything below it", () => {
    assert.isTrue(isPathContained("/a/proj", "/a/proj"));
    assert.isTrue(isPathContained("/a/proj/src/lib", "/a/proj"));
    assert.isTrue(isPathContained("/a/proj/", "/a/proj"));
  });

  it("rejects a sibling whose name merely starts with the root — the startsWith trap", () => {
    assert.isFalse(isPathContained("/a/project-evil", "/a/proj"));
    assert.isFalse(isPathContained("/a/proj-backup/secrets", "/a/proj"));
  });

  it("rejects a parent and an unrelated path", () => {
    assert.isFalse(isPathContained("/a", "/a/proj"));
    assert.isFalse(isPathContained("/etc/passwd", "/a/proj"));
  });

  it("rejects an empty candidate or root rather than matching everything", () => {
    assert.isFalse(isPathContained("", "/a/proj"));
    assert.isFalse(isPathContained("/a/proj", ""));
  });

  it("does not resolve `..` itself — the caller compares realpaths", () => {
    // `/a/proj/../../etc` is textually under `/a/proj`; the service therefore
    // never relies on this predicate alone, it resolves both sides first.
    assert.isTrue(isPathContained("/a/proj/../../etc", "/a/proj"));
  });
});

describe("findContainingRoot", () => {
  it("returns the matching root, normalized", () => {
    assert.strictEqual(findContainingRoot("/a/proj/src", ["/other", "/a/proj/"]), "/a/proj");
  });

  it("returns null when nothing contains the candidate", () => {
    assert.strictEqual(findContainingRoot("/tmp/elsewhere", ["/a/proj", "/b/proj"]), null);
  });

  it("returns null for an empty root set, so an empty workspace denies everything", () => {
    assert.strictEqual(findContainingRoot("/a/proj", []), null);
  });
});

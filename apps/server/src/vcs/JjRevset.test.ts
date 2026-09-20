import { assert, describe, it } from "@effect/vitest";

import {
  localBookmarkRevset,
  refNameToRevset,
  remoteBookmarkRevset,
  splitRemoteRefName,
} from "./JjRevset.ts";

describe("JjRevset", () => {
  it("splits a ref name only against a known remote, longest first", () => {
    assert.deepStrictEqual(splitRemoteRefName("origin/feature/x", ["origin"]), {
      remote: "origin",
      name: "feature/x",
    });
    assert.deepStrictEqual(splitRemoteRefName("origin/fork/main", ["origin", "origin/fork"]), {
      remote: "origin/fork",
      name: "main",
    });
    assert.equal(splitRemoteRefName("origin/main", []), null);
    assert.equal(splitRemoteRefName("feature/x", ["origin"]), null);
    assert.equal(splitRemoteRefName("origin/", ["origin"]), null);
  });

  it("converts a remote ref to jj's name@remote form", () => {
    assert.equal(refNameToRevset("origin/main", ["origin"]), "main@origin");
    assert.equal(remoteBookmarkRevset("upstream", "feature/x"), "feature/x@upstream");
  });

  it("converts a bookmark name to an exact bookmark revset", () => {
    assert.equal(refNameToRevset("feature/x", ["origin"]), 'bookmarks(exact:"feature/x")');
    assert.equal(localBookmarkRevset('weird"name\\'), 'bookmarks(exact:"weird\\"name\\\\")');
  });

  it("passes revisions through unchanged", () => {
    const commitId = "b17b3034179d638b3a97c41e17e7ffe25b8c4f74";
    assert.equal(refNameToRevset(commitId, ["origin"]), commitId);
    const changeId = "yzsrwslzmszllqvknmplyrnqmplsmpym";
    assert.equal(refNameToRevset(changeId, ["origin"]), changeId);
  });
});

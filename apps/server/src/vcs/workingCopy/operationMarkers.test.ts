import { assert, describe, it } from "@effect/vitest";

import { isOperationMarkerEntry, operationFromGitDirEntries } from "./operationMarkers.ts";

describe("operationFromGitDirEntries", () => {
  it("maps each marker to its operation", () => {
    assert.strictEqual(operationFromGitDirEntries(["rebase-merge"]), "rebase");
    assert.strictEqual(operationFromGitDirEntries(["rebase-apply"]), "rebase");
    assert.strictEqual(operationFromGitDirEntries(["MERGE_HEAD"]), "merge");
    assert.strictEqual(operationFromGitDirEntries(["CHERRY_PICK_HEAD"]), "cherry-pick");
    assert.strictEqual(operationFromGitDirEntries(["REVERT_HEAD"]), "revert");
  });

  it("answers null for a git dir with no marker", () => {
    assert.strictEqual(
      operationFromGitDirEntries(["HEAD", "config", "index", "objects", "refs"]),
      null,
    );
  });

  it("answers null for an empty listing rather than guessing", () => {
    assert.strictEqual(operationFromGitDirEntries([]), null);
  });

  it("prefers rebase when an interactive rebase also leaves a cherry-pick head", () => {
    assert.strictEqual(operationFromGitDirEntries(["CHERRY_PICK_HEAD", "rebase-merge"]), "rebase");
  });

  it("prefers merge over cherry-pick and revert", () => {
    assert.strictEqual(
      operationFromGitDirEntries(["REVERT_HEAD", "CHERRY_PICK_HEAD", "MERGE_HEAD"]),
      "merge",
    );
  });

  it("ignores unrelated entries alongside a marker", () => {
    assert.strictEqual(
      operationFromGitDirEntries(["index", "MERGE_HEAD", "COMMIT_EDITMSG"]),
      "merge",
    );
  });
});

describe("isOperationMarkerEntry", () => {
  it("recognises exactly the five marker names", () => {
    assert.isTrue(isOperationMarkerEntry("rebase-merge"));
    assert.isTrue(isOperationMarkerEntry("rebase-apply"));
    assert.isTrue(isOperationMarkerEntry("MERGE_HEAD"));
    assert.isTrue(isOperationMarkerEntry("CHERRY_PICK_HEAD"));
    assert.isTrue(isOperationMarkerEntry("REVERT_HEAD"));
    assert.isFalse(isOperationMarkerEntry("HEAD"));
    assert.isFalse(isOperationMarkerEntry("index"));
    assert.isFalse(isOperationMarkerEntry("COMMIT_EDITMSG"));
  });
});

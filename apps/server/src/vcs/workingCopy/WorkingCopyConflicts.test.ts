import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { abortOperation, resolveConflict } from "./WorkingCopyConflicts.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import {
  git,
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

/** A repository stopped in the middle of a conflicted merge. */
const makeConflictedMerge = Effect.fn("test.makeConflictedMerge")(function* () {
  const repo = yield* makeTestRepository();
  yield* writeFile(repo.cwd, "conflict.ts", "base\n");
  yield* stagePaths(repo.git, ["conflict.ts"]);
  yield* commitStaged(repo.git, "base");

  yield* git(repo.cwd, ["checkout", "-q", "-b", "side"]);
  yield* writeFile(repo.cwd, "conflict.ts", "theirs\n");
  yield* stagePaths(repo.git, ["conflict.ts"]);
  yield* commitStaged(repo.git, "side");

  yield* git(repo.cwd, ["checkout", "-q", "main"]);
  yield* writeFile(repo.cwd, "conflict.ts", "ours\n");
  yield* stagePaths(repo.git, ["conflict.ts"]);
  yield* commitStaged(repo.git, "main");

  // Expected to fail; the conflicted state is the fixture.
  yield* repo.git.run({ operation: "test.merge", args: ["merge", "side"], mutating: true });
  return repo;
});

it.layer(WorkingCopyTestLayer)("resolveConflict", (it) => {
  it.effect("takes ours and marks the file resolved", () =>
    Effect.gen(function* () {
      const repo = yield* makeConflictedMerge();

      yield* resolveConflict(repo.git, { path: "conflict.ts", side: "ours" });

      assert.strictEqual(yield* readFile(repo.cwd, "conflict.ts"), "ours\n");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.isFalse(status.files.some((file) => file.area === "conflicted"));
      // Still mid-merge: resolving a file is not continuing the operation.
      assert.strictEqual(status.operationInProgress, "merge");
    }),
  );

  it.effect("takes theirs", () =>
    Effect.gen(function* () {
      const repo = yield* makeConflictedMerge();

      yield* resolveConflict(repo.git, { path: "conflict.ts", side: "theirs" });

      assert.strictEqual(yield* readFile(repo.cwd, "conflict.ts"), "theirs\n");
    }),
  );

  it.effect("marks a hand-edited file resolved without touching its contents", () =>
    Effect.gen(function* () {
      const repo = yield* makeConflictedMerge();
      yield* writeFile(repo.cwd, "conflict.ts", "hand merged\n");

      yield* resolveConflict(repo.git, { path: "conflict.ts" });

      assert.strictEqual(yield* readFile(repo.cwd, "conflict.ts"), "hand merged\n");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.isFalse(status.files.some((file) => file.area === "conflicted"));
    }),
  );
});

it.layer(WorkingCopyTestLayer)("abortOperation", (it) => {
  it.effect("aborts a merge and clears the marker", () =>
    Effect.gen(function* () {
      const repo = yield* makeConflictedMerge();

      yield* abortOperation(repo.git, "merge");

      const status = yield* readWorkingCopyStatus(repo.git);
      assert.strictEqual(status.operationInProgress, null);
      assert.deepStrictEqual(status.files, []);
      assert.strictEqual(yield* readFile(repo.cwd, "conflict.ts"), "ours\n");
    }),
  );

  it.effect("surfaces git's refusal when there is nothing to abort", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const failure = yield* abortOperation(repo.git, "rebase").pipe(Effect.flip);

      assert.strictEqual(failure._tag, "VcsProcessExitError");
    }),
  );
});

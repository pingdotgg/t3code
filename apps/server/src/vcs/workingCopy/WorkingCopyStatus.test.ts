import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import {
  git,
  makeTestRepository,
  removeFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

it.layer(WorkingCopyTestLayer)("readWorkingCopyStatus", (it) => {
  it.effect("reports an unborn repository without a ref and without ahead/behind", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.strictEqual(status.isRepo, true);
      assert.strictEqual(status.refName, "main");
      assert.strictEqual(status.detached, false);
      assert.strictEqual(status.hasUpstream, false);
      assert.strictEqual(status.operationInProgress, null);
      // No upstream means **no numbers**; 0/0 would render as "in sync".
      assert.isUndefined(status.ahead);
      assert.isUndefined(status.behind);
      assert.deepStrictEqual(status.files, []);
    }),
  );

  it.effect("splits an MM path into a staged row and an unstaged row with separate counts", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);

      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\n");

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.deepStrictEqual(
        status.files.map((file) => [file.area, file.change]),
        [
          ["staged", "modified"],
          ["unstaged", "modified"],
        ],
      );
      assert.strictEqual(status.files[0]?.insertions, 1);
      assert.strictEqual(status.files[1]?.insertions, 1);
    }),
  );

  it.effect("carries a rename's source path on the staged row", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "old.ts", "content\n".repeat(20));
      yield* git(repo.cwd, ["add", "old.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* git(repo.cwd, ["mv", "old.ts", "new.ts"]);

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.deepStrictEqual(status.files, [
        {
          path: "new.ts",
          area: "staged",
          change: "renamed",
          oldPath: "old.ts",
          // A pure rename really is 0/0 — the numstat merge keys renames by
          // their **new** path, which is what makes that lookup hit.
          insertions: 0,
          deletions: 0,
        },
      ]);
    }),
  );

  it.effect("reports an untracked file in the unstaged group with no counts", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "fresh.ts", "hello\n");

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.deepStrictEqual(status.files, [
        { path: "fresh.ts", area: "unstaged", change: "untracked" },
      ]);
    }),
  );

  it.effect("reports a deletion", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "gone.ts", "bye\n");
      yield* git(repo.cwd, ["add", "gone.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* removeFile(repo.cwd, "gone.ts");

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area, file.change]),
        [["gone.ts", "unstaged", "deleted"]],
      );
    }),
  );

  it.effect("surfaces a merge conflict as one conflicted row and names the operation", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "conflict.ts", "base\n");
      yield* git(repo.cwd, ["add", "conflict.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);

      yield* git(repo.cwd, ["checkout", "-b", "side"]);
      yield* writeFile(repo.cwd, "conflict.ts", "side\n");
      yield* git(repo.cwd, ["commit", "-am", "side"]);

      yield* git(repo.cwd, ["checkout", "main"]);
      yield* writeFile(repo.cwd, "conflict.ts", "main\n");
      yield* git(repo.cwd, ["commit", "-am", "main"]);

      // The merge fails; that is the state under test, not an error.
      yield* repo.git.run({
        operation: "test.merge",
        args: ["merge", "side"],
        mutating: true,
      });

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.strictEqual(status.operationInProgress, "merge");
      assert.deepStrictEqual(status.files, [
        { path: "conflict.ts", area: "conflicted", change: "unmerged" },
      ]);
    }),
  );

  it.effect("reports a detached HEAD with a null ref name", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* git(repo.cwd, ["checkout", "--detach", "HEAD"]);

      const status = yield* readWorkingCopyStatus(repo.git);

      assert.strictEqual(status.refName, null);
      assert.strictEqual(status.detached, true);
    }),
  );
});

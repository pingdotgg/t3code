import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkingCopyInvalidRevisionError } from "@t3tools/contracts";
import {
  checkoutCommit,
  cherryPick,
  resetToCommit,
  revertCommit,
  tagCommit,
} from "./WorkingCopyHistoryActions.ts";
import { commitStaged, undoLastCommit } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import {
  git,
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

it.layer(WorkingCopyTestLayer)("history actions", (it) => {
  it.effect("cherry-picks a commit and reports the new commit for the undo toast", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "base.ts", "base\n");
      yield* stagePaths(repo.git, ["base.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* git(repo.cwd, ["checkout", "-q", "-b", "side"]);
      yield* writeFile(repo.cwd, "side.ts", "side\n");
      yield* stagePaths(repo.git, ["side.ts"]);
      const sideCommit = yield* commitStaged(repo.git, "side work");

      yield* git(repo.cwd, ["checkout", "-q", "main"]);
      yield* writeFile(repo.cwd, "main.ts", "main\n");
      yield* stagePaths(repo.git, ["main.ts"]);
      yield* commitStaged(repo.git, "main work");

      const picked = yield* cherryPick(repo.git, sideCommit.hash);

      assert.notStrictEqual(picked.hash, sideCommit.hash);
      assert.strictEqual(picked.filesChanged, 1);
      assert.strictEqual(yield* readFile(repo.cwd, "side.ts"), "side\n");

      // The undo toast's target really does undo it.
      yield* undoLastCommit(repo.git);
      const subject = yield* git(repo.cwd, ["log", "-1", "--format=%s"]);
      assert.strictEqual(subject.trim(), "main work");
    }),
  );

  it.effect("reverts a commit as a new commit rather than rewriting history", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const target = yield* commitStaged(repo.git, "add two");

      const reverted = yield* revertCommit(repo.git, { hash: target.hash });

      assert.notStrictEqual(reverted.hash, target.hash);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "one\n");
      const count = yield* git(repo.cwd, ["rev-list", "--count", "HEAD"]);
      assert.strictEqual(count.trim(), "3");
    }),
  );

  it.effect("checks a commit out detached", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const first = yield* commitStaged(repo.git, "first");
      yield* writeFile(repo.cwd, "a.ts", "two\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "second");

      yield* checkoutCommit(repo.git, first.hash);

      const status = yield* readWorkingCopyStatus(repo.git);
      assert.strictEqual(status.detached, true);
      assert.strictEqual(status.refName, null);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "one\n");
    }),
  );

  it.effect("resets soft, mixed and hard with the right survivors", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const first = yield* commitStaged(repo.git, "first");
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "second");

      yield* resetToCommit(repo.git, { hash: first.hash, mode: "soft" });
      let status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => file.area),
        ["staged"],
      );

      yield* resetToCommit(repo.git, { hash: first.hash, mode: "mixed" });
      status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => file.area),
        ["unstaged"],
      );
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "one\ntwo\n");

      yield* resetToCommit(repo.git, { hash: first.hash, mode: "hard" });
      status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(status.files, []);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "one\n");
    }),
  );

  it.effect("creates a lightweight and an annotated tag", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const created = yield* commitStaged(repo.git, "base");

      yield* tagCommit(repo.git, { hash: created.hash, name: "v1" });
      yield* tagCommit(repo.git, { hash: created.hash, name: "v2", message: "release" });

      const tags = yield* git(repo.cwd, ["tag", "--list"]);
      assert.deepStrictEqual(tags.trim().split("\n").sort(), ["v1", "v2"]);
      const annotated = yield* git(repo.cwd, ["cat-file", "-t", "v2"]);
      assert.strictEqual(annotated.trim(), "tag");
    }),
  );

  it.effect("refuses a revision expression on every hash-taking action", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      for (const attempt of [
        cherryPick(repo.git, "HEAD"),
        revertCommit(repo.git, { hash: "HEAD~1" }),
        checkoutCommit(repo.git, "main"),
        resetToCommit(repo.git, { hash: "--hard", mode: "soft" }),
        tagCommit(repo.git, { hash: "HEAD", name: "v1" }),
      ]) {
        const failure = yield* attempt.pipe(Effect.flip);
        assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
      }
    }),
  );
});

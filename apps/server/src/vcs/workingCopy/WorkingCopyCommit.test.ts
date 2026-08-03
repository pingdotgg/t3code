import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  amendCommit,
  commitStaged,
  lastCommitMessage,
  undoLastCommit,
} from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import {
  git,
  makeTestRepository,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

it.layer(WorkingCopyTestLayer)("commitStaged", (it) => {
  it.effect("commits only the staged subset and never touches the rest of the index", () =>
    Effect.gen(function* () {
      // This is the §5.0.2 regression in test form. `git.runStackedAction`'s
      // commit path runs `reset` + `add -A` first, so a user who staged one of
      // two dirty files would have committed both.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* git(repo.cwd, ["add", "a.ts", "b.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);

      yield* writeFile(repo.cwd, "a.ts", "a changed\n");
      yield* writeFile(repo.cwd, "b.ts", "b changed\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      const result = yield* commitStaged(repo.git, "only a");

      assert.strictEqual(result.filesChanged, 1);
      assert.match(result.hash, /^[0-9a-f]{40}$/);
      assert.isAbove(result.shortHash.length, 0);

      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [["b.ts", "unstaged"]],
      );

      const committed = yield* git(repo.cwd, ["show", "--name-only", "--format=", "HEAD"]);
      assert.include(committed, "a.ts");
      assert.notInclude(committed, "b.ts");
    }),
  );

  it.effect("carries a message that would be impossible as argv, over stdin", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      // Newlines, a leading dash, quotes and a `$(...)` — none of which can be
      // interpreted, because there is no shell and no `-m`.
      const message = '-fix(scope): "quoted" $(whoami)\n\nbody line\nsecond line\n';
      yield* commitStaged(repo.git, message);

      const stored = yield* git(repo.cwd, ["log", "-1", "--format=%B"]);
      assert.strictEqual(stored.replace(/\n+$/, ""), message.replace(/\n+$/, ""));
    }),
  );

  it.effect("commits nothing extra when the worktree has unstaged changes to the same file", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);

      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\n");

      yield* commitStaged(repo.git, "staged half");

      const committed = yield* git(repo.cwd, ["show", "HEAD:a.ts"]);
      assert.strictEqual(committed, "one\ntwo\n");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => file.area),
        ["unstaged"],
      );
    }),
  );
});

it.layer(WorkingCopyTestLayer)("amendCommit / undoLastCommit / lastCommitMessage", (it) => {
  it.effect("amends the message without changing the tree", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "typo");

      yield* amendCommit(repo.git, "fixed subject\n\nwith a body\n");

      const stored = yield* git(repo.cwd, ["log", "-1", "--format=%B"]);
      assert.include(stored, "fixed subject");
      assert.include(stored, "with a body");
      const count = yield* git(repo.cwd, ["rev-list", "--count", "HEAD"]);
      assert.strictEqual(count.trim(), "1");
    }),
  );

  it.effect("amends with --no-edit when no message is supplied", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "keep me");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* stagePaths(repo.git, ["b.ts"]);

      yield* amendCommit(repo.git, undefined);

      const stored = yield* git(repo.cwd, ["log", "-1", "--format=%s"]);
      assert.strictEqual(stored.trim(), "keep me");
      const files = yield* git(repo.cwd, ["show", "--name-only", "--format=", "HEAD"]);
      assert.include(files, "b.ts");
    }),
  );

  it.effect("undoes the last commit softly, leaving the index staged", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "first");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* stagePaths(repo.git, ["b.ts"]);
      yield* commitStaged(repo.git, "second");

      yield* undoLastCommit(repo.git);

      const count = yield* git(repo.cwd, ["rev-list", "--count", "HEAD"]);
      assert.strictEqual(count.trim(), "1");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [["b.ts", "staged"]],
      );
    }),
  );

  it.effect("answers null for the last message in an unborn repository", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      assert.deepStrictEqual(yield* lastCommitMessage(repo.git), { message: null });
    }),
  );

  it.effect("returns the full last message, body included", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "subject\n\nbody\n");

      assert.deepStrictEqual(yield* lastCommitMessage(repo.git), {
        message: "subject\n\nbody",
      });
    }),
  );
});

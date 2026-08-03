import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkingCopyInvalidRevisionError } from "@t3tools/contracts";
import { readCommitFileDiff, readDiff, readFileAtRef } from "./WorkingCopyDiff.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  git,
  makeTestRepository,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

it.layer(WorkingCopyTestLayer)("readDiff", (it) => {
  it.effect("reads the worktree side and the index side separately", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "one\nstaged\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "one\nstaged\nunstaged\n");

      const staged = yield* readDiff(repo.git, { path: "a.ts", staged: true });
      const unstaged = yield* readDiff(repo.git, { path: "a.ts", staged: false });

      assert.include(staged.patch, "+staged");
      assert.notInclude(staged.patch, "+unstaged");
      assert.include(unstaged.patch, "+unstaged");
      assert.notInclude(unstaged.patch, "+staged");
    }),
  );

  it.effect("produces a patch for an untracked file via --no-index", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "fresh.ts", "brand new\n");

      const diff = yield* readDiff(repo.git, { path: "fresh.ts", staged: false });

      assert.include(diff.patch, "+brand new");
    }),
  );

  it.effect("emits a rename header when both sides are named", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "old.ts", "line\n".repeat(20));
      yield* stagePaths(repo.git, ["old.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* git(repo.cwd, ["mv", "old.ts", "new.ts"]);

      const diff = yield* readDiff(repo.git, {
        path: "new.ts",
        staged: true,
        oldPath: "old.ts",
      });

      assert.include(diff.patch, "rename from old.ts");
      assert.include(diff.patch, "rename to new.ts");
      assert.notInclude(diff.patch, "new file mode");
    }),
  );

  it.effect("returns an empty patch for a clean file rather than failing", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");

      const diff = yield* readDiff(repo.git, { path: "a.ts", staged: false });

      assert.strictEqual(diff.patch, "");
      assert.strictEqual(diff.truncated, false);
    }),
  );
});

it.layer(WorkingCopyTestLayer)("readFileAtRef", (it) => {
  it.effect("reads the index side with a bare `:` and a commit side by hash", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const created = yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "staged\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "worktree\n");

      const index = yield* readFileAtRef(repo.git, { rev: ":", path: "a.ts" });
      const head = yield* readFileAtRef(repo.git, { rev: created.hash, path: "a.ts" });

      assert.deepStrictEqual(index, { content: "staged\n", exists: true, truncated: false });
      assert.deepStrictEqual(head, { content: "committed\n", exists: true, truncated: false });
    }),
  );

  it.effect("answers `exists: false` for a path missing at that rev", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const created = yield* commitStaged(repo.git, "base");

      const missing = yield* readFileAtRef(repo.git, { rev: created.hash, path: "nope.ts" });

      assert.deepStrictEqual(missing, { content: "", exists: false, truncated: false });
    }),
  );

  it.effect("refuses a rev that is not an object name", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const failure = yield* readFileAtRef(repo.git, { rev: "HEAD", path: "a.ts" }).pipe(
        Effect.flip,
      );

      assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
    }),
  );
});

it.layer(WorkingCopyTestLayer)("readCommitFileDiff", (it) => {
  it.effect("scopes the diff to one file of one commit", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* writeFile(repo.cwd, "b.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "one\na change\n");
      yield* writeFile(repo.cwd, "b.ts", "one\nb change\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      const created = yield* commitStaged(repo.git, "both");

      const diff = yield* readCommitFileDiff(repo.git, { hash: created.hash, path: "a.ts" });

      assert.include(diff.patch, "+a change");
      assert.notInclude(diff.patch, "+b change");
    }),
  );
});

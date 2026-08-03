import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyPatch,
  chunkPathsForExec,
  MAX_EXEC_ARGV_BYTES,
  MAX_EXEC_PATHS,
  stagePaths,
  unstagePaths,
} from "./WorkingCopyStaging.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import {
  git,
  makeTestRepository,
  removeFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

describe("chunkPathsForExec", () => {
  it("de-duplicates first, because an MM path appears twice in the status list", () => {
    assert.deepStrictEqual(chunkPathsForExec(["a.ts", "a.ts", "b.ts", "a.ts"]), [["a.ts", "b.ts"]]);
  });

  it("splits at the path-count cap", () => {
    const paths = Array.from({ length: MAX_EXEC_PATHS + 1 }, (_, index) => `f${index}.ts`);

    const chunks = chunkPathsForExec(paths);

    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0]?.length, MAX_EXEC_PATHS);
    assert.strictEqual(chunks[1]?.length, 1);
  });

  it("splits at the argv-byte cap even when the path count is small", () => {
    // 40 paths of ~4 KiB each blows the byte budget long before 1 000 paths.
    const paths = Array.from({ length: 40 }, (_, index) => `${"d".repeat(4_000)}/${index}.ts`);

    const chunks = chunkPathsForExec(paths);

    assert.isAbove(chunks.length, 1);
    for (const chunk of chunks) {
      const bytes = chunk.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 1, 0);
      assert.isAtMost(bytes, MAX_EXEC_ARGV_BYTES);
    }
  });

  it("never emits an empty chunk and never drops a path", () => {
    const paths = Array.from({ length: 2_500 }, (_, index) => `f${index}.ts`);

    const chunks = chunkPathsForExec(paths);

    assert.isFalse(chunks.some((chunk) => chunk.length === 0));
    assert.deepStrictEqual(chunks.flat(), paths);
  });

  it("returns no chunks for an empty selection", () => {
    assert.deepStrictEqual(chunkPathsForExec([]), []);
  });
});

describe("batch reporting", () => {
  /** A recorded fake, so "which chunk failed" is a receipt rather than a guess. */
  const makeFailingGit = (failFromCall: number) => {
    const calls: Array<ReadonlyArray<string>> = [];
    let call = 0;
    const run = (input: { readonly args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        call += 1;
        calls.push(input.args);
        const failing = call >= failFromCall;
        return {
          exitCode: (failing ? 1 : 0) as never,
          stdout: "",
          stderr: failing ? "fatal: pathspec did not match any files" : "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      });
    return {
      calls,
      git: { cwd: "/repo", run, ok: run } as unknown as Parameters<typeof stagePaths>[0],
    };
  };

  it.effect("reports the two chunks that landed when the third fails", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: MAX_EXEC_PATHS * 2 + 5 }, (_, index) => `f${index}.ts`);
      const { calls, git: fake } = makeFailingGit(3);

      const result = yield* stagePaths(fake, paths);

      assert.strictEqual(calls.length, 3);
      assert.strictEqual(result.staged, MAX_EXEC_PATHS * 2);
      assert.strictEqual(result.failed?.paths.length, 5);
      assert.include(result.failed?.detail ?? "", "pathspec did not match");
    }),
  );

  // fork: f4 — "empty means everything" is one invocation, never zero.
  it.effect("runs exactly one pathless invocation for an empty selection", () =>
    Effect.gen(function* () {
      const { calls, git: fake } = makeFailingGit(99);

      const result = yield* stagePaths(fake, []);

      assert.deepStrictEqual(calls, [["--literal-pathspecs", "add", "-A", "--"]]);
      assert.deepStrictEqual(result, { staged: 0 });
    }),
  );

  it.effect("stops at the first failing chunk rather than continuing to mutate", () =>
    Effect.gen(function* () {
      const paths = Array.from({ length: MAX_EXEC_PATHS * 3 }, (_, index) => `f${index}.ts`);
      const { calls, git: fake } = makeFailingGit(1);

      const result = yield* stagePaths(fake, paths);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(result.staged, 0);
    }),
  );
});

it.layer(WorkingCopyTestLayer)("stagePaths / unstagePaths", (it) => {
  it.effect("stages exactly the named paths and leaves the rest alone", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* writeFile(repo.cwd, "b.ts", "b\n");

      const result = yield* stagePaths(repo.git, ["a.ts"]);

      assert.deepStrictEqual(result, { staged: 1 });
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [
          ["a.ts", "staged"],
          ["b.ts", "unstaged"],
        ],
      );
    }),
  );

  // fork: f4 — the composer's "commit all" rung sends `paths: []`.
  it.effect("stages every dirty file when the selection is empty", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* writeFile(repo.cwd, "nested/b.ts", "b\n");

      yield* stagePaths(repo.git, []);

      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [
          ["a.ts", "staged"],
          ["nested/b.ts", "staged"],
        ],
      );
    }),
  );

  it.effect("unstages everything when the selection is empty", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* writeFile(repo.cwd, "b.ts", "b\n");
      yield* stagePaths(repo.git, []);

      yield* unstagePaths(repo.git, []);

      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [
          ["a.ts", "unstaged"],
          ["b.ts", "unstaged"],
        ],
      );
    }),
  );

  it.effect("stages a deletion", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* removeFile(repo.cwd, "a.ts");

      const result = yield* stagePaths(repo.git, ["a.ts"]);

      assert.strictEqual(result.staged, 1);
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area, file.change]),
        [["a.ts", "staged", "deleted"]],
      );
    }),
  );

  it.effect("de-duplicates an MM path so it is staged once", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\n");

      // The status list really does contain this path twice.
      const result = yield* stagePaths(repo.git, ["a.ts", "a.ts"]);

      assert.deepStrictEqual(result, { staged: 1 });
    }),
  );

  it.effect("surfaces git's own stderr, untruncated, when a chunk is refused", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const result = yield* stagePaths(repo.git, ["../escape.ts"]);

      assert.strictEqual(result.staged, 0);
      assert.deepStrictEqual(result.failed?.paths, ["../escape.ts"]);
      assert.include(result.failed?.detail ?? "", "outside repository");
    }),
  );

  it.effect("unstages back to the worktree without touching the file", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* git(repo.cwd, ["add", "a.ts"]);
      yield* git(repo.cwd, ["commit", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      const result = yield* unstagePaths(repo.git, ["a.ts"]);

      assert.deepStrictEqual(result, { staged: 1 });
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area]),
        [["a.ts", "unstaged"]],
      );
    }),
  );

  it.effect("stages a single hunk into the index, leaving the rest unstaged", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* git(repo.cwd, ["commit", "-q", "-m", "base"]);
      yield* writeFile(
        repo.cwd,
        "a.ts",
        "TOP\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nBOTTOM\n",
      );

      // Only the first hunk. `--recount` is what lets a hand-built header be
      // slightly off without git refusing the patch.
      const patch = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,4 @@",
        "+TOP",
        " one",
        " two",
        " three",
        "",
      ].join("\n");

      yield* applyPatch(repo.git, { patch, cached: true });

      const staged = yield* git(repo.cwd, ["diff", "--cached"]);
      assert.include(staged, "+TOP");
      assert.notInclude(staged, "+BOTTOM");
      const unstaged = yield* git(repo.cwd, ["diff"]);
      assert.include(unstaged, "+BOTTOM");
    }),
  );

  it.effect("unstages a hunk by applying it reversed to the index", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* git(repo.cwd, ["commit", "-q", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\nthree\nfour\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      const patch = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,4 @@",
        " one",
        " two",
        " three",
        "+four",
        "",
      ].join("\n");

      yield* applyPatch(repo.git, { patch, cached: true, reverse: true });

      assert.strictEqual((yield* git(repo.cwd, ["diff", "--cached"])).trim(), "");
      assert.include(yield* git(repo.cwd, ["diff"]), "+four");
    }),
  );

  it.effect("newline-terminates a patch that is not, so git does not refuse it", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* git(repo.cwd, ["commit", "-q", "-m", "base"]);
      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");

      const patch = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1,2 @@",
        " one",
        "+two",
      ].join("\n");

      yield* applyPatch(repo.git, { patch, cached: true });

      assert.include(yield* git(repo.cwd, ["diff", "--cached"]), "+two");
    }),
  );

  it.effect("unstages on an unborn HEAD, where `reset HEAD` cannot resolve", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "a\n");
      yield* stagePaths(repo.git, ["a.ts"]);

      const result = yield* unstagePaths(repo.git, ["a.ts"]);

      assert.deepStrictEqual(result, { staged: 1 });
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(
        status.files.map((file) => [file.path, file.area, file.change]),
        [["a.ts", "unstaged", "untracked"]],
      );
    }),
  );
});

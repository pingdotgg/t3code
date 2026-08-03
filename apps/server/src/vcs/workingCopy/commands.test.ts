import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkingCopyInvalidRevisionError } from "@t3tools/contracts";
import * as commands from "./commands.ts";

describe("hash-ish validation", () => {
  it("accepts 4 to 40 hex characters in either case", () => {
    assert.isTrue(commands.isHashIsh("abcd"));
    assert.isTrue(commands.isHashIsh("DEADBEEF"));
    assert.isTrue(commands.isHashIsh("0".repeat(40)));
  });

  it("rejects anything that could be read as an option or a revision expression", () => {
    for (const rejected of [
      "abc",
      "0".repeat(41),
      "--upload-pack=rm -rf /",
      "HEAD",
      "HEAD~1",
      "main",
      "abcdef^{tree}",
      "abcd ef01",
      "",
    ]) {
      assert.isFalse(commands.isHashIsh(rejected), rejected);
    }
  });

  it.effect("requireHashIsh fails with the revision on the error rather than reaching git", () =>
    Effect.gen(function* () {
      const failure = yield* commands
        .requireHashIsh("workingCopy.test", "--exec=boom")
        .pipe(Effect.flip);

      assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
      assert.strictEqual(failure.rev, "--exec=boom");
      assert.strictEqual(failure.operation, "workingCopy.test");
    }),
  );

  // fork: f4 — the tag name is positional argv too.
  it("isValidRefName rejects anything git could read as an option", () => {
    assert.isFalse(commands.isValidRefName("-d"));
    assert.isFalse(commands.isValidRefName("--force"));
    assert.isFalse(commands.isValidRefName("-F/etc/passwd"));
  });

  it("isValidRefName applies check-ref-format's own rules", () => {
    assert.isTrue(commands.isValidRefName("v1.2.3"));
    assert.isTrue(commands.isValidRefName("release/2024-06"));
    assert.isFalse(commands.isValidRefName(""));
    assert.isFalse(commands.isValidRefName("has space"));
    assert.isFalse(commands.isValidRefName("a..b"));
    assert.isFalse(commands.isValidRefName("a@{1}"));
    assert.isFalse(commands.isValidRefName("a:b"));
    assert.isFalse(commands.isValidRefName("a?b"));
    assert.isFalse(commands.isValidRefName("a*b"));
    assert.isFalse(commands.isValidRefName("a[b"));
    assert.isFalse(commands.isValidRefName("a~b"));
    assert.isFalse(commands.isValidRefName("a^b"));
    assert.isFalse(commands.isValidRefName("a\\b"));
    assert.isFalse(commands.isValidRefName("a//b"));
    assert.isFalse(commands.isValidRefName("a/"));
    assert.isFalse(commands.isValidRefName("/a"));
    assert.isFalse(commands.isValidRefName("a."));
    assert.isFalse(commands.isValidRefName(".hidden"));
    assert.isFalse(commands.isValidRefName("a/.b"));
    assert.isFalse(commands.isValidRefName("a.lock"));
    assert.isFalse(commands.isValidRefName("@"));
  });

  it.effect("requireRefName fails with the name rather than reaching git", () =>
    Effect.gen(function* () {
      const error = yield* commands.requireRefName("workingCopy.tagCommit", "-d").pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkingCopyInvalidRevisionError");
      assert.strictEqual(error.rev, "-d");
    }),
  );

  it.effect("requireStashRef accepts only `stash@{n}`", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* commands.requireStashRef("workingCopy.test", "stash@{12}"),
        "stash@{12}",
      );
      const failure = yield* commands
        .requireStashRef("workingCopy.test", "stash@{HEAD}")
        .pipe(Effect.flip);
      assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
    }),
  );
});

describe("status argv", () => {
  it("disables quotePath and asks for NUL-separated porcelain v1 with all untracked files", () => {
    assert.deepStrictEqual(commands.statusArgs(), [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v1",
      "-uall",
      "-z",
    ]);
  });
});

describe("staging argv", () => {
  it("stages with literal pathspecs after a `--` terminator", () => {
    assert.deepStrictEqual(commands.stageArgs(["-weird.ts", "b.ts"]), [
      "--literal-pathspecs",
      "add",
      "-A",
      "--",
      "-weird.ts",
      "b.ts",
    ]);
  });

  it("unstages against HEAD when there is one", () => {
    assert.deepStrictEqual(commands.unstageArgs(["a.ts"], { hasHead: true }), [
      "--literal-pathspecs",
      "reset",
      "-q",
      "HEAD",
      "--",
      "a.ts",
    ]);
  });

  it("drops from the index instead when HEAD is unborn", () => {
    assert.deepStrictEqual(commands.unstageArgs(["a.ts"], { hasHead: false }), [
      "--literal-pathspecs",
      "rm",
      "-q",
      "--cached",
      "-r",
      "--",
      "a.ts",
    ]);
  });

  it("builds the three hunk-apply shapes", () => {
    assert.deepStrictEqual(commands.applyPatchArgs({ cached: true }), [
      "apply",
      "--whitespace=nowarn",
      "--recount",
      "--cached",
      "-",
    ]);
    assert.deepStrictEqual(commands.applyPatchArgs({ cached: true, reverse: true }), [
      "apply",
      "--whitespace=nowarn",
      "--recount",
      "--cached",
      "--reverse",
      "-",
    ]);
    assert.deepStrictEqual(commands.applyPatchArgs({ reverse: true }), [
      "apply",
      "--whitespace=nowarn",
      "--recount",
      "--reverse",
      "-",
    ]);
  });
});

describe("commit argv", () => {
  it("reads the message from stdin with `-F -` and never stages anything", () => {
    const args = commands.commitStagedArgs();

    assert.deepStrictEqual(args, ["commit", "-F", "-"]);
    assert.notInclude(args, "-m");
    assert.notInclude(args, "add");
    assert.notInclude(args, "-a");
    assert.notInclude(args, "reset");
  });

  it("amends over stdin when a message is supplied and `--no-edit` otherwise", () => {
    assert.deepStrictEqual(commands.amendCommitArgs({ hasMessage: true }), [
      "commit",
      "--amend",
      "-F",
      "-",
    ]);
    assert.deepStrictEqual(commands.amendCommitArgs({ hasMessage: false }), [
      "commit",
      "--amend",
      "--no-edit",
    ]);
  });

  it("undoes with a soft reset so the index and worktree survive", () => {
    assert.deepStrictEqual(commands.undoLastCommitArgs(), ["reset", "--soft", "HEAD~1"]);
  });
});

describe("log argv", () => {
  it("asks for limit + 1 so hasMore is answered, not guessed", () => {
    assert.include(commands.logArgs({ limit: 50 }), "--max-count=51");
  });

  it("pages with `--skip=1 <hash>` and never `<hash>~1`", () => {
    const args = commands.logArgs({ limit: 20, before: "a".repeat(40) });

    assert.include(args, "--skip=1");
    assert.include(args, "a".repeat(40));
    assert.isFalse(args.some((arg) => arg.includes("~1")));
  });

  it("uses fixed strings for search so `fix(` is not an invalid regex", () => {
    const args = commands.logArgs({ limit: 10, grep: "fix(" });

    assert.include(args, "--fixed-strings");
    assert.include(args, "--regexp-ignore-case");
    assert.include(args, "--grep=fix(");
  });

  it("omits the regex flags entirely when there is no text filter", () => {
    const args = commands.logArgs({ limit: 10 });

    assert.notInclude(args, "--fixed-strings");
    assert.notInclude(args, "--regexp-ignore-case");
  });

  it("terminates pathspecs with `--`", () => {
    const args = commands.logArgs({ limit: 10, paths: ["src/a.ts"] });

    assert.deepStrictEqual(args.slice(-2), ["--", "src/a.ts"]);
  });

  it("clamps the limit to the documented default and ceiling", () => {
    assert.strictEqual(commands.clampLogLimit(undefined), commands.DEFAULT_LOG_LIMIT);
    assert.strictEqual(commands.clampLogLimit(0), 1);
    assert.strictEqual(commands.clampLogLimit(1_000_000), commands.MAX_LOG_LIMIT);
    assert.strictEqual(commands.clampLogLimit(120), 120);
  });

  it("separates fields and records with \\x1f and \\x1e", () => {
    assert.strictEqual(commands.LOG_FIELD_SEPARATOR, "\x1f");
    assert.strictEqual(commands.LOG_RECORD_SEPARATOR, "\x1e");
    assert.strictEqual(
      commands.LOG_FORMAT,
      "--format=%H\x1f%h\x1f%s\x1f%an\x1f%ae\x1f%aI\x1f%P\x1e",
    );
  });
});

describe("commit-scoped reads", () => {
  it("passes --first-parent so a merge commit shows a file list", () => {
    assert.include(commands.commitDetailArgs("abcd"), "--first-parent");
    assert.include(commands.commitNameStatusArgs("abcd"), "--first-parent");
    assert.include(commands.commitNumstatArgs("abcd"), "--first-parent");
    assert.include(commands.commitFileDiffArgs({ hash: "abcd", path: "a.ts" }), "--first-parent");
  });

  it("dereferences annotated tags in the for-each-ref format", () => {
    assert.include(commands.commitRefsArgs().join(" "), "%(*objectname)");
  });

  it("names both sides of a rename so git emits a rename header", () => {
    assert.deepStrictEqual(
      commands.diffArgs({ staged: false, path: "new.ts", oldPath: "old.ts" }).slice(-3),
      ["--", "old.ts", "new.ts"],
    );
  });

  it("reads the index side of a file with a bare `:` prefix", () => {
    assert.deepStrictEqual(commands.fileAtRefArgs(":", "src/a.ts"), ["show", ":src/a.ts"]);
    assert.deepStrictEqual(commands.fileAtRefArgs("abcd", "src/a.ts"), ["show", "abcd:src/a.ts"]);
  });
});

describe("stash argv", () => {
  it("never passes --literal-pathspecs, which silently breaks --include-untracked", () => {
    // `git stash` builds its own magic pathspecs to find untracked files; the
    // global flag disables that magic and leaves them on disk.
    const args = commands.stashPushArgs({ includeUntracked: true, paths: ["a.ts"] });

    assert.notInclude(args, "--literal-pathspecs");
    assert.include(args, "--include-untracked");
  });

  it("makes each path literal with per-pathspec magic instead", () => {
    const args = commands.stashPushArgs({
      includeUntracked: true,
      message: "t3-backup: 1 path(s)",
      paths: ["a[1].ts"],
    });

    assert.deepStrictEqual(args.slice(-2), ["--", ":(literal)a[1].ts"]);
  });

  it("omits the pathspec terminator entirely for a whole-tree stash", () => {
    const args = commands.stashPushArgs({ includeUntracked: true });

    assert.notInclude(args, "--");
  });
});

describe("history mutation argv", () => {
  it("builds each abort per operation", () => {
    assert.deepStrictEqual(commands.abortOperationArgs("merge"), ["merge", "--abort"]);
    assert.deepStrictEqual(commands.abortOperationArgs("rebase"), ["rebase", "--abort"]);
    assert.deepStrictEqual(commands.abortOperationArgs("cherry-pick"), ["cherry-pick", "--abort"]);
    assert.deepStrictEqual(commands.abortOperationArgs("revert"), ["revert", "--abort"]);
  });

  it("passes the mainline only when reverting a merge", () => {
    assert.deepStrictEqual(commands.revertCommitArgs({ hash: "abcd" }), [
      "revert",
      "--no-edit",
      "abcd",
    ]);
    assert.deepStrictEqual(commands.revertCommitArgs({ hash: "abcd", mainline: 1 }), [
      "revert",
      "--no-edit",
      "-m",
      "1",
      "abcd",
    ]);
  });

  it("checks a commit out detached rather than leaving a surprise branch state", () => {
    assert.deepStrictEqual(commands.checkoutCommitArgs("abcd"), ["checkout", "--detach", "abcd"]);
  });

  it("builds the three reset modes", () => {
    assert.deepStrictEqual(commands.resetToCommitArgs("abcd", "soft"), ["reset", "--soft", "abcd"]);
    assert.deepStrictEqual(commands.resetToCommitArgs("abcd", "mixed"), [
      "reset",
      "--mixed",
      "abcd",
    ]);
    assert.deepStrictEqual(commands.resetToCommitArgs("abcd", "hard"), ["reset", "--hard", "abcd"]);
  });

  it("annotates a tag only when a message is given", () => {
    assert.deepStrictEqual(commands.tagCommitArgs({ hash: "abcd", name: "v1" }), [
      "tag",
      "v1",
      "abcd",
    ]);
    assert.deepStrictEqual(
      commands.tagCommitArgs({ hash: "abcd", name: "v1", message: "release" }),
      ["tag", "-a", "v1", "-m", "release", "abcd"],
    );
  });
});

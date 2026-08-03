import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  backupMessage,
  discardDestructively,
  discardPaths,
  listDiscardBackups,
  restoreDiscardBackup,
  supportsPathspecStash,
} from "./WorkingCopyDiscard.ts";
import { readStashList } from "./WorkingCopyStash.ts";
import { readWorkingCopyStatus } from "./WorkingCopyStatus.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import {
  git,
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

describe("supportsPathspecStash", () => {
  it("requires git >= 2.13, the release that added `stash push -- <paths>`", () => {
    assert.isFalse(supportsPathspecStash("git version 2.12.5"));
    assert.isTrue(supportsPathspecStash("git version 2.13.0"));
    assert.isTrue(supportsPathspecStash("git version 2.39.3 (Apple Git-146)"));
    assert.isTrue(supportsPathspecStash("git version 3.0.0"));
  });

  it("refuses to guess when the version cannot be read", () => {
    assert.isFalse(supportsPathspecStash(""));
    assert.isFalse(supportsPathspecStash("git version unknown"));
  });
});

describe("backupMessage", () => {
  it("always carries the prefix the prune step keys on", () => {
    assert.isTrue(backupMessage("3 files", 3).startsWith("t3-backup:"));
    assert.isTrue(backupMessage(undefined, 0).startsWith("t3-backup:"));
  });
});

it.layer(WorkingCopyTestLayer)("discardPaths", (it) => {
  it.effect("reverts the named paths, keeps a prefixed backup, and reports recoverable", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* writeFile(repo.cwd, "b.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* writeFile(repo.cwd, "b.ts", "also dirty\n");

      const result = yield* discardPaths(repo.git, { paths: ["a.ts"], label: "a.ts" });

      assert.strictEqual(result.recoverable, true);
      assert.deepStrictEqual(result.discardedPaths, ["a.ts"]);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      // The paths that were not named are untouched.
      assert.strictEqual(yield* readFile(repo.cwd, "b.ts"), "also dirty\n");

      const stashes = yield* readStashList(repo.git);
      assert.strictEqual(stashes.length, 1);
      assert.isTrue(stashes[0]?.isDiscardBackup);
      assert.include(stashes[0]?.label ?? "", "t3-backup:");
      // The handle is the stash COMMIT, not `stash@{0}`: it has to survive a
      // second discard renumbering the stack under the undo toast.
      assert.strictEqual(result.backupRef, stashes[0]?.commit);
      assert.match(result.backupRef ?? "", /^[0-9a-f]{40}$/);
    }),
  );

  it.effect("restores exactly the discarded bytes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "precious edit\n");

      const result = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");

      yield* restoreDiscardBackup(repo.git, result.backupRef ?? "stash@{0}");

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "precious edit\n");
      // `pop` removed the backup, so undo cannot be replayed twice.
      assert.deepStrictEqual(yield* listDiscardBackups(repo.git), []);
    }),
  );

  it.effect("backs up an untracked file too", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "keep.ts", "keep\n");
      yield* stagePaths(repo.git, ["keep.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "fresh.ts", "brand new\n");

      const result = yield* discardPaths(repo.git, { paths: ["fresh.ts"] });

      assert.strictEqual(result.recoverable, true);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);

      yield* restoreDiscardBackup(repo.git, result.backupRef ?? "stash@{0}");
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), "brand new\n");
    }),
  );

  it.effect("refuses an unbackable discard and destroys nothing until it is confirmed", () =>
    Effect.gen(function* () {
      // Unborn HEAD: nothing to stash against. The answer must arrive BEFORE
      // anything is destroyed, or the confirm-first rung can never fire on the
      // first discard in a fresh `git init`.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "fresh.ts", "unborn\n");

      const preflight = yield* discardPaths(repo.git, { paths: ["fresh.ts"] });

      assert.strictEqual(preflight.requiresConfirmation, true);
      assert.strictEqual(preflight.recoverable, false);
      assert.deepStrictEqual(preflight.discardedPaths, []);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), "unborn\n");
    }),
  );

  it.effect("discards irrecoverably once the client confirms", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "fresh.ts", "unborn\n");

      const result = yield* discardPaths(repo.git, {
        paths: ["fresh.ts"],
        confirmedDestructive: true,
      });

      assert.strictEqual(result.recoverable, false);
      assert.isUndefined(result.requiresConfirmation);
      assert.isUndefined(result.backupRef);
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);
    }),
  );

  it.effect("undo pops the right backup after a second discard renumbered the stack", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed a\n");
      yield* writeFile(repo.cwd, "b.ts", "committed b\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "precious a\n");
      const first = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      yield* writeFile(repo.cwd, "b.ts", "precious b\n");
      yield* discardPaths(repo.git, { paths: ["b.ts"] });

      // `a.ts`'s backup is now `stash@{1}`. Undoing by the handle taken at
      // discard time must restore `a.ts`, never `b.ts`.
      yield* restoreDiscardBackup(repo.git, first.backupRef ?? "");

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "precious a\n");
      assert.strictEqual(yield* readFile(repo.cwd, "b.ts"), "committed b\n");
      const remaining = yield* listDiscardBackups(repo.git);
      assert.strictEqual(remaining.length, 1);
    }),
  );

  it.effect("fails loudly when the referenced backup is gone rather than popping stash@{0}", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      const result = yield* discardPaths(repo.git, { paths: ["a.ts"] });
      yield* git(repo.cwd, ["stash", "drop", "stash@{0}"]);

      const error = yield* restoreDiscardBackup(repo.git, result.backupRef ?? "").pipe(Effect.flip);

      assert.strictEqual(error._tag, "WorkingCopyInvalidRevisionError");
    }),
  );

  it.effect("the destructive fallback resets to HEAD, not just to the index", () =>
    Effect.gen(function* () {
      // Same semantics as the stash path. `checkout -- <paths>` alone restores
      // the worktree from the INDEX, so a file with both a staged and an
      // unstaged edit would keep its staged half while the confirm dialog said
      // the changes were lost permanently.
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "staged edit\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* writeFile(repo.cwd, "a.ts", "worktree edit\n");

      yield* discardDestructively(repo.git, ["a.ts"]);

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(status.files, []);
    }),
  );

  it.effect("discards everything when no paths are named", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* writeFile(repo.cwd, "fresh.ts", "new\n");

      const result = yield* discardPaths(repo.git, { paths: [] });

      assert.strictEqual(result.recoverable, true);
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      assert.strictEqual(yield* readFile(repo.cwd, "fresh.ts"), null);
      const status = yield* readWorkingCopyStatus(repo.git);
      assert.deepStrictEqual(status.files, []);
    }),
  );

  it.effect("prunes to 10 backups and touches only prefixed stashes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");

      // One stash the user made themselves; it must survive every prune.
      yield* writeFile(repo.cwd, "a.ts", "user work\n");
      yield* git(repo.cwd, ["stash", "push", "-m", "my own work"]);

      for (let round = 0; round < 12; round += 1) {
        yield* writeFile(repo.cwd, "a.ts", `dirty ${round}\n`);
        yield* discardPaths(repo.git, { paths: ["a.ts"], label: `round ${round}` });
      }

      const backups = yield* listDiscardBackups(repo.git);
      assert.strictEqual(backups.length, 10);

      const all = yield* readStashList(repo.git);
      const mine = all.filter((entry) => !entry.isDiscardBackup);
      assert.deepStrictEqual(
        mine.map((entry) => entry.label),
        ["my own work"],
      );
    }),
  );

  it.effect("listDiscardBackups excludes the user's own stashes", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "user work\n");
      yield* git(repo.cwd, ["stash", "push", "-m", "mine"]);
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* discardPaths(repo.git, { paths: ["a.ts"] });

      const backups = yield* listDiscardBackups(repo.git);

      assert.strictEqual(backups.length, 1);
      assert.isTrue(backups[0]?.isDiscardBackup);
    }),
  );
});

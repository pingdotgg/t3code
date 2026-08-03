import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkingCopyInvalidRevisionError } from "@t3tools/contracts";
import { LOG_FIELD_SEPARATOR, LOG_RECORD_SEPARATOR } from "./commands.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  isDiscardBackupLabel,
  parseStashList,
  parseStashSubject,
  readStashList,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
} from "./WorkingCopyStash.ts";
import {
  makeTestRepository,
  readFile,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

describe("parseStashSubject", () => {
  it("strips the `WIP on <branch>:` and `On <branch>:` prefixes and keeps the branch", () => {
    assert.deepStrictEqual(parseStashSubject("WIP on main: 1a2b3c earlier work"), {
      label: "1a2b3c earlier work",
      branch: "main",
    });
    assert.deepStrictEqual(parseStashSubject("On feature/x: t3-backup: 2 path(s)"), {
      label: "t3-backup: 2 path(s)",
      branch: "feature/x",
    });
  });

  it("passes an unprefixed subject through with a null branch", () => {
    assert.deepStrictEqual(parseStashSubject("bare"), { label: "bare", branch: null });
  });
});

describe("isDiscardBackupLabel", () => {
  it("matches only the panel's own prefix", () => {
    assert.isTrue(isDiscardBackupLabel("t3-backup: 2 path(s)"));
    assert.isFalse(isDiscardBackupLabel("my own work"));
    assert.isFalse(isDiscardBackupLabel("not-t3-backup: sneaky"));
  });
});

describe("parseStashList", () => {
  const record = (ref: string, subject: string) =>
    [ref, "a".repeat(40), subject, "2024-05-01T10:00:00+02:00"]
      .join(LOG_FIELD_SEPARATOR)
      .concat(LOG_RECORD_SEPARATOR);

  // fork: f4 — `%H` is the immutable handle the discard undo toast holds.
  it("keeps the stash commit so a handle can outlive a renumbering", () => {
    const entries = parseStashList(record("stash@{0}", "On main: t3-backup: 1 path(s)"));
    assert.strictEqual(entries[0]?.commit, "a".repeat(40));
  });

  it("parses the index out of the stash ref", () => {
    const entries = parseStashList(
      `${record("stash@{0}", "On main: t3-backup: 1 path(s)")}\n${record("stash@{1}", "WIP on main: earlier")}`,
    );

    assert.deepStrictEqual(
      entries.map((entry) => [entry.index, entry.ref, entry.isDiscardBackup]),
      [
        [0, "stash@{0}", true],
        [1, "stash@{1}", false],
      ],
    );
  });

  it("skips a record whose ref is not a stash handle", () => {
    assert.deepStrictEqual(parseStashList(record("HEAD", "On main: x")), []);
  });

  it("returns nothing for an empty list", () => {
    assert.deepStrictEqual(parseStashList(""), []);
  });
});

it.layer(WorkingCopyTestLayer)("stash operations", (it) => {
  it.effect("pushes, lists, applies and drops", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "work in progress\n");

      yield* stashPush(repo.git, { message: "my work", includeUntracked: true });

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "committed\n");
      const listed = yield* readStashList(repo.git);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.label, "my work");
      assert.strictEqual(listed[0]?.branch, "main");
      assert.isFalse(listed[0]?.isDiscardBackup);

      yield* stashApply(repo.git, "stash@{0}");
      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "work in progress\n");
      // apply keeps the entry; drop removes it.
      assert.strictEqual((yield* readStashList(repo.git)).length, 1);

      yield* stashDrop(repo.git, "stash@{0}");
      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );

  it.effect("pops in one step", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "committed\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");
      yield* writeFile(repo.cwd, "a.ts", "dirty\n");
      yield* stashPush(repo.git, { includeUntracked: true });

      yield* stashPop(repo.git, "stash@{0}");

      assert.strictEqual(yield* readFile(repo.cwd, "a.ts"), "dirty\n");
      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );

  it.effect("refuses a stash handle that is not `stash@{n}` before reaching git", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const failure = yield* stashDrop(repo.git, "refs/stash").pipe(Effect.flip);

      assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
    }),
  );

  it.effect("lists nothing in a repository that has never stashed", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      assert.deepStrictEqual(yield* readStashList(repo.git), []);
    }),
  );
});

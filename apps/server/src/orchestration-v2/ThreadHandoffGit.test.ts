import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  classifyIncomingTip,
  handoffPreTagName,
  handoffRefName,
  handoffStashLabel,
  HandoffUntrackedCollisionError,
  layer as threadHandoffGitLayer,
  ThreadHandoffGit,
  type ClassifyIncomingTipInput,
} from "./ThreadHandoffGit.ts";

const input = (overrides: Partial<ClassifyIncomingTipInput>): ClassifyIncomingTipInput => ({
  localTip: "local",
  incomingTip: "incoming",
  incomingContainsLocal: false,
  localContainsIncoming: false,
  hasCommonAncestor: true,
  ...overrides,
});

describe("classifyIncomingTip", () => {
  it("advances a branch the receiving repository does not have yet", () => {
    assert.strictEqual(classifyIncomingTip(input({ localTip: null })), "advance");
  });

  it("absorbs an identical tip instead of moving anything", () => {
    assert.strictEqual(
      classifyIncomingTip(input({ localTip: "same", incomingTip: "same" })),
      "absorb",
    );
  });

  it("advances when the incoming commit descends from the local tip", () => {
    assert.strictEqual(classifyIncomingTip(input({ incomingContainsLocal: true })), "advance");
  });

  it("absorbs when the receiving side is already ahead", () => {
    assert.strictEqual(classifyIncomingTip(input({ localContainsIncoming: true })), "absorb");
  });

  it("refuses when both sides moved, so neither tip is a descendant of the other", () => {
    assert.strictEqual(classifyIncomingTip(input({})), "diverged");
  });

  it("refuses unrelated histories rather than treating them as a divergence to rebase", () => {
    assert.strictEqual(classifyIncomingTip(input({ hasCommonAncestor: false })), "unrelated");
  });

  it("treats a fast-forward as advance even when common ancestry was not computed", () => {
    assert.strictEqual(
      classifyIncomingTip(input({ incomingContainsLocal: true, hasCommonAncestor: false })),
      "advance",
    );
  });

  it("never advances on a tip that only the local side contains", () => {
    const classification = classifyIncomingTip(
      input({ localContainsIncoming: true, hasCommonAncestor: true }),
    );

    assert.notStrictEqual(classification, "advance");
  });
});

describe("handoff ref names", () => {
  it("parks refused commits under an environment-scoped namespace", () => {
    assert.strictEqual(
      handoffRefName("environment-mac", "feat/thread-handoff"),
      "refs/handoff/environment-mac/feat/thread-handoff",
    );
  });

  it("keeps each refused handoff's parked commit under its own ref", () => {
    assert.strictEqual(
      handoffRefName("environment-mac", "feat/thread-handoff", "handoff-1"),
      "refs/handoff/environment-mac/handoff-1/feat/thread-handoff",
    );
  });

  it("rewrites characters git refuses inside a ref name", () => {
    assert.strictEqual(handoffRefName("env one", "feat/a..b~c"), "refs/handoff/env-one/feat/a-b-c");
  });

  it("names the pre-move tag after the hop that moved the pointer", () => {
    assert.strictEqual(handoffPreTagName("handoff-1"), "handoff-pre-handoff-1");
  });

  it("puts the base sha in the stash label so a later pop is legible", () => {
    assert.strictEqual(
      handoffStashLabel("handoff-1", "a91f2c4"),
      "handoff-overwritten-handoff-1-base-a91f2c4",
    );
  });
});

const GitLayer = threadHandoffGitLayer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** Runs a command through the same process service the git helpers use. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.flatMap(VcsProcess.VcsProcess, (process) =>
    process.run({ operation: "thread-handoff.test", command, args, cwd }),
  );

const git = (args: ReadonlyArray<string>, cwd: string) => run("git", args, cwd);

const write = (dir: string, relative: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(dir, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
    return target;
  });

const tempDir = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

/** A repository with one tracked, committed file. */
const makeRepo = Effect.gen(function* () {
  const cwd = yield* tempDir("t3-handoff-git-repo-");
  yield* git(["init", "-b", "main"], cwd);
  yield* git(["config", "user.email", "test@test.com"], cwd);
  yield* git(["config", "user.name", "Test"], cwd);
  yield* git(["config", "commit.gpgsign", "false"], cwd);
  yield* write(cwd, "tracked.txt", "committed\n");
  yield* git(["add", "tracked.txt"], cwd);
  yield* git(["commit", "-m", "initial"], cwd);
  return cwd;
});

/** Tars `paths` from `source` into a fresh archive, the way `archivePaths` does. */
const makeArchive = (source: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const archiveDir = yield* tempDir("t3-handoff-git-archive-");
    const archivePath = path.join(archiveDir, "untracked.tar.gz");
    yield* run("tar", ["-czf", archivePath, ...paths], source);
    return archivePath;
  });

it.layer(GitLayer)("ThreadHandoffGit against a real repository", (it) => {
  describe("extractArchive", () => {
    it.effect("refuses when a sender file collides with a tracked file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        const sender = yield* tempDir("t3-handoff-git-sender-");
        yield* write(sender, "tracked.txt", "from the sender\n");
        const archivePath = yield* makeArchive(sender, ["tracked.txt"]);

        const error = yield* Effect.flip(handoffGit.extractArchive({ cwd, archivePath }));

        assert.instanceOf(error, HandoffUntrackedCollisionError);
        assert.deepStrictEqual([...error.collisions], ["tracked.txt"]);
        // The worktree is untouched and the staging directory is cleaned up.
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "committed\n");
        assert.isFalse(yield* fs.exists(`${archivePath}.staging`));
      }),
    );

    it.effect("refuses when a sender symlink collides with a tracked file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        const sender = yield* tempDir("t3-handoff-git-sender-");
        yield* write(sender, "elsewhere.txt", "link target\n");
        yield* fs.symlink("elsewhere.txt", path.join(sender, "tracked.txt"));
        const archivePath = yield* makeArchive(sender, ["tracked.txt"]);

        const error = yield* Effect.flip(handoffGit.extractArchive({ cwd, archivePath }));

        assert.instanceOf(error, HandoffUntrackedCollisionError);
        assert.deepStrictEqual([...error.collisions], ["tracked.txt"]);
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "committed\n");
      }),
    );

    it.effect("extracts non-colliding files, dotfiles and nested paths included", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        const sender = yield* tempDir("t3-handoff-git-sender-");
        yield* write(sender, ".env", "SECRET=1\n");
        yield* write(sender, "nested/new.txt", "brand new\n");
        const archivePath = yield* makeArchive(sender, [".env", "nested"]);

        yield* handoffGit.extractArchive({ cwd, archivePath });

        assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".env")), "SECRET=1\n");
        assert.strictEqual(
          yield* fs.readFileString(path.join(cwd, "nested/new.txt")),
          "brand new\n",
        );
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "committed\n");
        assert.isFalse(yield* fs.exists(`${archivePath}.staging`));
      }),
    );
  });

  describe("stashWorktree", () => {
    it.effect("returns null when there is nothing to stash", () =>
      Effect.gen(function* () {
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;

        assert.strictEqual(yield* handoffGit.stashWorktree({ cwd, label: "clean" }), null);
      }),
    );

    it.effect("stashes a dirty worktree, leaving the committed content behind", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        yield* write(cwd, "tracked.txt", "dirty\n");

        const stashRef = yield* handoffGit.stashWorktree({ cwd, label: "dirty" });

        assert.isNotNull(stashRef);
        assert.match(stashRef ?? "", /^[0-9a-f]{40}$/);
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "committed\n");
        assert.strictEqual(yield* handoffGit.dirtyFileCount({ cwd }), 0);
      }),
    );

    it.effect("pops a stash back into the worktree by its reflog name", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        yield* write(cwd, "tracked.txt", "dirty\n");
        yield* handoffGit.stashWorktree({ cwd, label: "dirty" });

        yield* handoffGit.popStash({ cwd, stashRef: "stash@{0}" });

        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "dirty\n");
      }),
    );

    // Every caller persists the sha `stashWorktree` returns, not a reflog
    // slot: the slot goes stale the moment another stash lands, the sha does
    // not. Popping by sha is therefore the contract that matters.
    it.effect("pops a stash by the sha stashWorktree returns and drops the entry", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        yield* write(cwd, "tracked.txt", "dirty\n");
        const stashRef = yield* handoffGit.stashWorktree({ cwd, label: "dirty" });
        assert.isNotNull(stashRef);

        yield* handoffGit.popStash({ cwd, stashRef: stashRef ?? "" });

        assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tracked.txt")), "dirty\n");
      }),
    );
  });

  describe("createBundle", () => {
    it.effect("skips an exclusion tip this repository has never seen", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        const outputPath = path.join(yield* tempDir("t3-handoff-git-bundle-"), "objects.bundle");

        const created = yield* handoffGit.createBundle({
          cwd,
          outputPath,
          refs: ["refs/heads/main"],
          excludeTips: ["0000000000000000000000000000000000000001"],
        });

        assert.isTrue(created);
        assert.isTrue(yield* fs.exists(outputPath));
      }),
    );
  });

  describe("worktrees", () => {
    it.effect("adds and removes a worktree, leaving the branch usable again", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit;
        const cwd = yield* makeRepo;
        const head = yield* handoffGit.resolveHead({ cwd });
        const worktreePath = path.join(yield* tempDir("t3-handoff-git-wt-"), "checkout");

        yield* handoffGit.addWorktree({ cwd, path: worktreePath, commit: head });
        yield* handoffGit.checkoutBranchAt({ cwd: worktreePath, branch: "side", commit: head });

        assert.isTrue(yield* fs.exists(path.join(worktreePath, "tracked.txt")));
        assert.strictEqual(
          yield* handoffGit.findWorktreeForBranch({ cwd, branch: "side" }),
          worktreePath,
        );
        assert.isTrue(yield* handoffGit.isBranchCheckedOut({ cwd, branch: "side" }));

        yield* handoffGit.removeWorktree({ cwd, path: worktreePath });

        assert.isFalse(yield* fs.exists(worktreePath));
        assert.isFalse(yield* handoffGit.isBranchCheckedOut({ cwd, branch: "side" }));
        // Usable again: the branch can be checked out somewhere else.
        yield* handoffGit.checkoutBranchAt({ cwd, branch: "side", commit: head });
        assert.isTrue(yield* handoffGit.isBranchCheckedOut({ cwd, branch: "side" }));
      }),
    );
  });
});

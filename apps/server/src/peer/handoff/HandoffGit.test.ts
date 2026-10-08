import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as HandoffGit from "./HandoffGit.ts";

// A thread's git work moves from the laptop's checkout to the box's clone of
// the same repository: the commits the remote lacks, the edits, the deletes
// and the new files, exactly, and nothing on the box is overwritten.

const layer = HandoffGit.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const sh = (cwd: string, args: ReadonlyArray<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((processes) =>
      processes.run({
        operation: "HandoffGit.test",
        command: "git",
        cwd,
        args,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      }),
    ),
    Effect.map((result) => result.stdout.trim()),
    Effect.orDie,
  );

/** `git status --porcelain`, sorted; untrimmed, since its first column is a space. */
const status = (cwd: string) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((processes) =>
      processes.run({
        operation: "HandoffGit.test",
        command: "git",
        cwd,
        args: ["status", "--porcelain"],
      }),
    ),
    Effect.map((result) =>
      result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .sort(),
    ),
    Effect.orDie,
  );

/** An origin with one commit on main, and the laptop's and the box's clones of it. */
const repos = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-handoff-git-" });
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  yield* fileSystem.makeDirectory(seed);
  yield* sh(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  yield* sh(seed, ["init", "--quiet", "--initial-branch=main"]);
  yield* fileSystem.writeFileString(path.join(seed, "app.ts"), "export const version = 1;\n");
  yield* fileSystem.writeFileString(path.join(seed, "old.ts"), "export const gone = true;\n");
  yield* sh(seed, ["add", "."]);
  yield* sh(seed, ["commit", "--quiet", "-m", "start"]);
  yield* sh(seed, ["remote", "add", "origin", origin]);
  yield* sh(seed, ["push", "--quiet", "origin", "main"]);
  const laptop = path.join(root, "laptop");
  const box = path.join(root, "box");
  yield* sh(root, ["clone", "--quiet", origin, laptop]);
  yield* sh(root, ["clone", "--quiet", origin, box]);
  const outDir = path.join(root, "out");
  yield* fileSystem.makeDirectory(outDir);
  return { root, origin, laptop, box, outDir };
});

/** The laptop's thread: an unpushed commit on a branch, then uncommitted work. */
const workOnLaptop = (laptop: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* sh(laptop, ["checkout", "--quiet", "-b", "fix/login"]);
    yield* fileSystem.writeFileString(path.join(laptop, "app.ts"), "export const version = 2;\n");
    yield* sh(laptop, ["commit", "--quiet", "-am", "unpushed: bump version"]);
    yield* fileSystem.writeFileString(path.join(laptop, "app.ts"), "export const version = 3;\n");
    yield* fileSystem.remove(path.join(laptop, "old.ts"));
    yield* fileSystem.writeFileString(path.join(laptop, "new.ts"), "export const fresh = true;\n");
    yield* fileSystem.writeFileString(path.join(laptop, ".env"), "SECRET=1\n");
    yield* fileSystem.writeFileString(path.join(laptop, ".gitignore"), ".env\n");
    yield* sh(laptop, ["add", "new.ts"]);
  });

it.layer(layer)("handing a thread's git work to another checkout", (it) => {
  it.effect("carries an unpushed commit, edits, deletes and new files exactly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoff = yield* HandoffGit.HandoffGit;
        const { laptop, box, outDir, root } = yield* repos;
        yield* workOnLaptop(laptop);
        const stagedBefore = yield* sh(laptop, ["diff", "--cached", "--name-only"]);

        const packed = yield* handoff.pack({ cwd: laptop, handoffId: "h1", outDir });
        assert.equal(packed.branch, "fix/login");
        // Packing leaves the laptop's own staging and refs as they were.
        assert.equal(yield* sh(laptop, ["diff", "--cached", "--name-only"]), stagedBefore);
        assert.equal(yield* sh(laptop, ["for-each-ref", "refs/t3code"]), "");

        const worktree = path.join(root, "box-worktree");
        const applied = yield* handoff.apply({
          repoRoot: box,
          worktreePath: worktree,
          handoffId: "h1",
          bundlePath: packed.bundlePath,
          branch: packed.branch,
          tip: packed.tip,
          snapshot: packed.snapshot,
        });
        assert.equal(applied.branch, "fix/login");
        // The committed work, unpushed on the laptop, is the branch here.
        assert.equal(yield* sh(worktree, ["rev-parse", "HEAD"]), packed.tip);
        assert.equal(yield* sh(worktree, ["log", "-1", "--format=%s"]), "unpushed: bump version");
        // The working tree matches, and shows as uncommitted.
        assert.equal(
          yield* fileSystem.readFileString(path.join(worktree, "app.ts")),
          "export const version = 3;\n",
        );
        assert.isFalse(yield* fileSystem.exists(path.join(worktree, "old.ts")));
        assert.equal(
          yield* fileSystem.readFileString(path.join(worktree, "new.ts")),
          "export const fresh = true;\n",
        );
        assert.deepEqual(yield* status(worktree), [
          " D old.ts",
          " M app.ts",
          "?? .gitignore",
          "?? new.ts",
        ]);
        // Ignored files stay where they were.
        assert.isFalse(yield* fileSystem.exists(path.join(worktree, ".env")));
        assert.equal(yield* sh(box, ["for-each-ref", "refs/t3code"]), "");
      }),
    ),
  );

  it.effect("refuses a branch that moved on here, and leaves everything as it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoff = yield* HandoffGit.HandoffGit;
        const { laptop, box, outDir, root } = yield* repos;
        yield* workOnLaptop(laptop);
        const packed = yield* handoff.pack({ cwd: laptop, handoffId: "h2", outDir });

        // The box has its own commit on the same branch.
        yield* sh(box, ["checkout", "--quiet", "-b", "fix/login"]);
        yield* fileSystem.writeFileString(path.join(box, "box.ts"), "export const mine = 1;\n");
        yield* sh(box, ["add", "."]);
        yield* sh(box, ["commit", "--quiet", "-m", "box-only work"]);
        yield* sh(box, ["checkout", "--quiet", "main"]);
        const boxBranch = yield* sh(box, ["rev-parse", "fix/login"]);
        const worktreesBefore = yield* sh(box, ["worktree", "list", "--porcelain"]);

        const refused = yield* handoff
          .apply({
            repoRoot: box,
            worktreePath: path.join(root, "box-worktree"),
            handoffId: "h2",
            bundlePath: packed.bundlePath,
            branch: packed.branch,
            tip: packed.tip,
            snapshot: packed.snapshot,
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "diverged");
        assert.equal(yield* sh(box, ["rev-parse", "fix/login"]), boxBranch);
        assert.equal(yield* sh(box, ["worktree", "list", "--porcelain"]), worktreesBefore);
        assert.equal(yield* sh(box, ["for-each-ref", "refs/t3code"]), "");
        assert.isFalse(yield* fileSystem.exists(path.join(root, "box-worktree")));
      }),
    ),
  );

  it.effect("moves a branch that is behind forward, and undoes it when a later step fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoff = yield* HandoffGit.HandoffGit;
        const { laptop, box, outDir, root } = yield* repos;
        yield* workOnLaptop(laptop);
        const packed = yield* handoff.pack({ cwd: laptop, handoffId: "h3", outDir });
        // The box has the branch at main, behind the laptop's tip.
        yield* sh(box, ["branch", "fix/login", "main"]);
        const before = yield* sh(box, ["rev-parse", "fix/login"]);

        // The worktree path is taken, so adding the worktree fails after the branch moved.
        const taken = path.join(root, "taken");
        yield* fileSystem.makeDirectory(taken);
        yield* fileSystem.writeFileString(path.join(taken, "keep.txt"), "mine\n");
        const failed = yield* handoff
          .apply({
            repoRoot: box,
            worktreePath: taken,
            handoffId: "h3",
            bundlePath: packed.bundlePath,
            branch: packed.branch,
            tip: packed.tip,
            snapshot: packed.snapshot,
          })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "git_failed");
        assert.equal(yield* sh(box, ["rev-parse", "fix/login"]), before);
        assert.equal(yield* sh(box, ["for-each-ref", "refs/t3code"]), "");
        assert.equal(yield* fileSystem.readFileString(path.join(taken, "keep.txt")), "mine\n");

        // With a free path it moves forward and applies.
        const applied = yield* handoff.apply({
          repoRoot: box,
          worktreePath: path.join(root, "box-worktree"),
          handoffId: "h3",
          bundlePath: packed.bundlePath,
          branch: packed.branch,
          tip: packed.tip,
          snapshot: packed.snapshot,
        });
        assert.equal(applied.branch, "fix/login");
        assert.equal(yield* sh(box, ["rev-parse", "fix/login"]), packed.tip);
      }),
    ),
  );

  it.effect("fetches the base a bundle builds on, and refuses work over the size limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoff = yield* HandoffGit.HandoffGit;
        const { laptop, box, outDir, root } = yield* repos;
        // The laptop's branch builds on a commit pushed after the box cloned.
        yield* fileSystem.writeFileString(path.join(laptop, "pushed.ts"), "export const p = 1;\n");
        yield* sh(laptop, ["add", "."]);
        yield* sh(laptop, ["commit", "--quiet", "-m", "pushed later"]);
        // Pushed through the remote, so the laptop knows origin has it and the
        // bundle leaves it out: the box has to fetch it.
        yield* sh(laptop, ["push", "--quiet", "origin", "main"]);
        yield* workOnLaptop(laptop);
        const packed = yield* handoff.pack({ cwd: laptop, handoffId: "h4", outDir });
        assert.isFalse(
          (yield* sh(packed.bundlePath.replace(/\/[^/]+$/, ""), [
            "bundle",
            "list-heads",
            packed.bundlePath,
          ])).includes(yield* sh(laptop, ["rev-parse", "main"])),
        );
        const applied = yield* handoff.apply({
          repoRoot: box,
          worktreePath: path.join(root, "box-worktree"),
          handoffId: "h4",
          bundlePath: packed.bundlePath,
          branch: packed.branch,
          tip: packed.tip,
          snapshot: packed.snapshot,
        });
        assert.equal(applied.branch, "fix/login");
        assert.isTrue(yield* fileSystem.exists(path.join(root, "box-worktree", "pushed.ts")));

        // An untracked file bigger than a handoff carries, and incompressible.
        const crypto = yield* Crypto.Crypto;
        yield* fileSystem.writeFile(
          path.join(laptop, "big.bin"),
          yield* crypto.randomBytes(HandoffGit.MAX_HANDOFF_BUNDLE_BYTES + 1024).pipe(Effect.orDie),
        );
        const tooLarge = yield* handoff
          .pack({ cwd: laptop, handoffId: "h5", outDir })
          .pipe(Effect.flip);
        assert.equal(tooLarge.reason, "too_large");
        assert.isFalse(yield* fileSystem.exists(path.join(outDir, "h5.bundle")));
      }),
    ),
  );
});

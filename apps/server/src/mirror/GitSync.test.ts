// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import * as GitSync from "./GitSync.ts";
import * as ProcessRunner from "../processRunner.ts";

const GitSyncTestLayer = GitSync.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "mirror-git-sync-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    // Snapshot/merge plumbing resolves real paths; macOS tmp dirs are symlinks.
    return yield* fileSystem.realPath(dir);
  });
}

function write(filePath: string, contents: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(NodePath.dirname(filePath), { recursive: true })
      .pipe(Effect.ignore);
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function readOption(filePath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  });
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "git",
      args,
      cwd,
      timeout: "30 seconds",
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    if (result.code !== 0) {
      return yield* Effect.die(
        new Error(`git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr}`),
      );
    }
    return result.stdout.trim();
  });
}

function initOriginRepo(cwd: string) {
  return Effect.gen(function* () {
    yield* git(cwd, ["init", "--initial-branch=main"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    // Keep assertions byte-exact regardless of the machine's global autocrlf.
    yield* git(cwd, ["config", "core.autocrlf", "false"]);
    yield* write(NodePath.join(cwd, "README.md"), "# hello\n");
    yield* write(NodePath.join(cwd, "src/app.ts"), "export const one = 1;\n");
    yield* write(NodePath.join(cwd, ".gitignore"), "ignored.log\n.env\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
    // Dirty state: one tracked edit, one untracked file, one ignored file.
    yield* write(
      NodePath.join(cwd, "src/app.ts"),
      "export const one = 1;\nexport const two = 2;\n",
    );
    yield* write(NodePath.join(cwd, "notes.txt"), "untracked notes\n");
    yield* write(NodePath.join(cwd, "ignored.log"), "must not sync\n");
    yield* write(NodePath.join(cwd, ".env"), "SECRET=yes\n");
  });
}

/** Seed a mirror from an origin the way MirrorService + MirrorAgent do. */
function seedMirror(input: {
  readonly origin: string;
  readonly mirror: string;
  readonly syncId: string;
  readonly includePaths?: ReadonlyArray<string>;
}) {
  return Effect.gen(function* () {
    const gitSync = yield* GitSync.GitSync;
    const fileSystem = yield* FileSystem.FileSystem;
    const bundlePath = NodePath.join(input.mirror, "..", `${input.syncId}.bundle`);
    const snapshot = yield* gitSync.createSnapshot({
      root: input.origin,
      syncId: input.syncId,
      ...(input.includePaths === undefined ? {} : { includePaths: input.includePaths }),
    });
    yield* gitSync.createSeedBundle({
      root: input.origin,
      bundlePath,
      snapshotRef: GitSync.mirrorSnapshotRef(input.syncId),
    });
    yield* gitSync.initRepository(input.mirror);
    yield* gitSync.fetchBundle({
      root: input.mirror,
      bundlePath,
      refspecs: [
        "+refs/heads/*:refs/heads/*",
        "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
      ],
    });
    const headRef = yield* gitSync.symbolicHead(input.origin);
    yield* gitSync.checkoutSeedHead(input.mirror, headRef, snapshot.snapshotOid);
    const headCommit = yield* gitSync.headCommit(input.mirror);
    if (headCommit !== null && headCommit !== snapshot.snapshotOid) {
      yield* gitSync.applySnapshot({
        root: input.mirror,
        syncId: input.syncId,
        baseOid: headCommit,
        targetOid: snapshot.snapshotOid,
        conflictPreference: "target",
      });
    }
    yield* fileSystem.remove(bundlePath, { force: true }).pipe(Effect.ignore);
    return snapshot;
  });
}

it.layer(GitSyncTestLayer)("GitSync", (it) => {
  describe("seed", () => {
    it.effect("reproduces the origin's dirty working tree, excluding ignored files", () =>
      Effect.gen(function* () {
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);

        yield* seedMirror({ origin, mirror, syncId: "seed-1" });

        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "src/app.ts")))).toBe(
          "export const one = 1;\nexport const two = 2;\n",
        );
        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "notes.txt")))).toBe(
          "untracked notes\n",
        );
        // Ignored files never sync without an include entry.
        expect(Option.isNone(yield* readOption(NodePath.join(mirror, "ignored.log")))).toBe(true);
        expect(Option.isNone(yield* readOption(NodePath.join(mirror, ".env")))).toBe(true);

        // Full history came along: the mirror is a normal repo on main.
        const gitSync = yield* GitSync.GitSync;
        expect(yield* gitSync.symbolicHead(mirror)).toBe("refs/heads/main");
        expect(yield* gitSync.headCommit(mirror)).toBe(yield* gitSync.headCommit(origin));
      }),
    );

    it.effect("mirror.include force-syncs declared gitignored paths", () =>
      Effect.gen(function* () {
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);

        yield* seedMirror({ origin, mirror, syncId: "seed-2", includePaths: [".env"] });

        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, ".env")))).toBe(
          "SECRET=yes\n",
        );
        expect(Option.isNone(yield* readOption(NodePath.join(mirror, "ignored.log")))).toBe(true);
      }),
    );
  });

  describe("incremental sync", () => {
    it.effect("ships edits, adds, and deletes; merges non-conflicting mirror-side edits", () =>
      Effect.gen(function* () {
        const gitSync = yield* GitSync.GitSync;
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);
        const seed = yield* seedMirror({ origin, mirror, syncId: "seed-3" });

        // Mirror-side edit between turns (UI writeFile / terminal output).
        yield* write(NodePath.join(mirror, "host-notes.txt"), "written on host\n");

        // Origin changes: edit, add, delete.
        yield* write(NodePath.join(origin, "src/app.ts"), "export const one = 111;\n");
        yield* write(NodePath.join(origin, "brand-new.txt"), "new file\n");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(NodePath.join(origin, "notes.txt"));

        const next = yield* gitSync.createSnapshot({ root: origin, syncId: "sync-1" });
        const bundlePath = NodePath.join(origin, "..", "sync-1.bundle");
        yield* gitSync.createIncrementalBundle({
          root: origin,
          bundlePath,
          baseOid: seed.snapshotOid,
          snapshotRef: GitSync.mirrorSnapshotRef("sync-1"),
          includeBranches: true,
        });
        yield* gitSync.fetchBundle({
          root: mirror,
          bundlePath,
          refspecs: ["+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*"],
        });
        const apply = yield* gitSync.applySnapshot({
          root: mirror,
          syncId: "sync-1",
          baseOid: seed.snapshotOid,
          targetOid: next.snapshotOid,
          conflictPreference: "target",
        });

        expect(apply.outcome).toBe("applied");
        expect(apply.conflictPaths).toEqual([]);
        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "src/app.ts")))).toBe(
          "export const one = 111;\n",
        );
        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "brand-new.txt")))).toBe(
          "new file\n",
        );
        expect(Option.isNone(yield* readOption(NodePath.join(mirror, "notes.txt")))).toBe(true);
        // The host-side edit survived the push (three-way merge, not overwrite).
        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "host-notes.txt")))).toBe(
          "written on host\n",
        );
      }),
    );

    it.effect("no-change detection: identical trees produce identical snapshot trees", () =>
      Effect.gen(function* () {
        const gitSync = yield* GitSync.GitSync;
        const origin = yield* makeTmpDir();
        yield* initOriginRepo(origin);

        const first = yield* gitSync.createSnapshot({ root: origin, syncId: "s1" });
        const second = yield* gitSync.createSnapshot({ root: origin, syncId: "s2" });
        expect(second.treeOid).toBe(first.treeOid);
        expect(yield* gitSync.treeOfCommit(origin, first.snapshotOid)).toBe(first.treeOid);
      }),
    );
  });

  describe("conflicts", () => {
    it.effect("target preference takes the incoming side and reports the path", () =>
      Effect.gen(function* () {
        const gitSync = yield* GitSync.GitSync;
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);
        const seed = yield* seedMirror({ origin, mirror, syncId: "seed-4" });

        // Both sides change the same file.
        yield* write(NodePath.join(mirror, "src/app.ts"), "host version\n");
        yield* write(NodePath.join(origin, "src/app.ts"), "laptop version\n");

        const next = yield* gitSync.createSnapshot({ root: origin, syncId: "sync-c" });
        const bundlePath = NodePath.join(origin, "..", "sync-c.bundle");
        yield* gitSync.createIncrementalBundle({
          root: origin,
          bundlePath,
          baseOid: seed.snapshotOid,
          snapshotRef: GitSync.mirrorSnapshotRef("sync-c"),
        });
        yield* gitSync.fetchBundle({
          root: mirror,
          bundlePath,
          refspecs: ["+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*"],
        });
        const apply = yield* gitSync.applySnapshot({
          root: mirror,
          syncId: "sync-c",
          baseOid: seed.snapshotOid,
          targetOid: next.snapshotOid,
          conflictPreference: "target",
        });

        expect(apply.outcome).toBe("conflicted");
        expect(apply.conflictPaths).toEqual(["src/app.ts"]);
        expect(Option.getOrNull(yield* readOption(NodePath.join(mirror, "src/app.ts")))).toBe(
          "laptop version\n",
        );
      }),
    );

    it.effect("local preference keeps this machine's version (apply-back semantics)", () =>
      Effect.gen(function* () {
        const gitSync = yield* GitSync.GitSync;
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);
        const seed = yield* seedMirror({ origin, mirror, syncId: "seed-5" });

        // Turn output on the mirror; concurrent user edit on the origin.
        yield* write(NodePath.join(mirror, "src/app.ts"), "agent version\n");
        yield* write(NodePath.join(origin, "src/app.ts"), "user version\n");

        const applyBack = yield* gitSync.createSnapshot({ root: mirror, syncId: "apply-1" });
        const bundlePath = NodePath.join(mirror, "..", "apply-1.bundle");
        yield* gitSync.createIncrementalBundle({
          root: mirror,
          bundlePath,
          baseOid: seed.snapshotOid,
          snapshotRef: GitSync.mirrorSnapshotRef("apply-1"),
        });
        yield* gitSync.fetchBundle({
          root: origin,
          bundlePath,
          refspecs: ["+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*"],
        });
        const apply = yield* gitSync.applySnapshot({
          root: origin,
          syncId: "apply-1",
          baseOid: seed.snapshotOid,
          targetOid: applyBack.snapshotOid,
          conflictPreference: "local",
        });

        expect(apply.outcome).toBe("conflicted");
        expect(apply.conflictPaths).toEqual(["src/app.ts"]);
        // The user's edit is untouched; the agent version stays in .git.
        expect(Option.getOrNull(yield* readOption(NodePath.join(origin, "src/app.ts")))).toBe(
          "user version\n",
        );
        expect(yield* gitSync.treeOfCommit(origin, applyBack.snapshotOid)).not.toBeNull();
      }),
    );
  });

  describe("branch updates", () => {
    it.effect("fast-forwards safe branches and parks diverged ones", () =>
      Effect.gen(function* () {
        const gitSync = yield* GitSync.GitSync;
        const origin = yield* makeTmpDir();
        const mirror = yield* makeTmpDir();
        yield* initOriginRepo(origin);
        yield* seedMirror({ origin, mirror, syncId: "seed-6" });

        // The mirror creates a feature branch (a worktree thread would).
        yield* git(mirror, ["checkout", "-b", "feature/x"]);
        yield* write(NodePath.join(mirror, "feature.txt"), "feature work\n");
        yield* git(mirror, ["add", "."]);
        yield* git(mirror, ["commit", "-m", "feature work"]);
        const featureOid = yield* git(mirror, ["rev-parse", "HEAD"]);
        yield* git(mirror, ["checkout", "main"]);

        const bundlePath = NodePath.join(mirror, "..", "branches.bundle");
        yield* git(mirror, ["bundle", "create", bundlePath, "refs/heads/feature/x"]);
        yield* gitSync.fetchBundle({
          root: origin,
          bundlePath,
          refspecs: ["+refs/heads/*:refs/t3/mirror/incoming/*"],
        });
        yield* gitSync.applyBranchUpdates({
          root: origin,
          refUpdates: [{ ref: "refs/heads/feature/x", oid: featureOid }],
        });
        // New branch lands directly.
        expect(yield* git(origin, ["rev-parse", "refs/heads/feature/x"])).toBe(featureOid);

        // The checked-out branch is never moved by applyBranchUpdates; the
        // incoming version parks under refs/t3/mirror/branches instead.
        const divergedOid = yield* git(origin, ["rev-parse", "refs/heads/main"]);
        yield* gitSync.applyBranchUpdates({
          root: origin,
          refUpdates: [{ ref: "refs/heads/main", oid: featureOid }],
        });
        expect(yield* git(origin, ["rev-parse", "refs/heads/main"])).toBe(divergedOid);
        expect(yield* git(origin, ["rev-parse", "refs/t3/mirror/branches/main"])).toBe(featureOid);
      }),
    );
  });
});

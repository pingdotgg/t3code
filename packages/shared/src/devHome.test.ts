// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { resolveGitWorktreePath, resolveWorktreeT3Home } from "./devHome.ts";

/**
 * Denying read on the `.git` file only proves anything for a user the mode
 * applies to. Root ignores it, and Windows has no equivalent, so the
 * unreadable case is skipped rather than silently passing there.
 */
const canDenyReads = typeof process.getuid === "function" && process.getuid() !== 0;

const makeRepo = (
  kind:
    | "worktree"
    | "checkout"
    | "no-repo"
    | "submodule"
    | "unparseable-git-file"
    | "unreadable-git-file"
    | "bare-repo-worktree"
    | "custom-common-dir-worktree"
    | "relative-worktree"
    | "windows-worktree"
    | "shallow-gitdir"
    | "nested-checkout",
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "bare-repo-worktree") {
        // `git worktree add` from a bare repo: the common dir is `<name>.git`.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/myrepo.git/worktrees/x\n");
      } else if (kind === "custom-common-dir-worktree") {
        // $GIT_COMMON_DIR need not be named `.git` at all.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/store/worktrees/x\n");
      } else if (kind === "relative-worktree") {
        // git >= 2.48 with `worktree.useRelativePaths` writes a relative pointer.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/worktrees/x\n");
      } else if (kind === "windows-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: C:\\repo\\.git\\worktrees\\x\n");
      } else if (kind === "shallow-gitdir") {
        // Nothing precedes `worktrees`, so there is no common dir to speak of.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: worktrees/x\n");
      } else if (kind === "submodule") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/modules/sub\n");
      } else if (kind === "unparseable-git-file") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "not a gitdir pointer\n");
      } else if (kind === "unreadable-git-file") {
        const gitPath = NodePath.join(root, ".git");
        NodeFS.writeFileSync(gitPath, "gitdir: /elsewhere/.git/worktrees/x\n");
        NodeFS.chmodSync(gitPath, 0o000);
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      if (kind === "nested-checkout") {
        // A worktree that contains a second, unrelated repository. Walking up
        // from inside the inner one must stop there, not adopt the outer root.
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
        NodeFS.mkdirSync(NodePath.join(root, "apps", "web", ".git"));
      }
      return { root, nested };
    }),
    ({ root }) =>
      Effect.sync(() => {
        // Restore read permission first: a 0o000 file is still removable, but
        // only because the directory is writable — do not depend on that.
        const gitPath = NodePath.join(root, ".git");
        if (NodeFS.existsSync(gitPath) && NodeFS.statSync(gitPath).isFile()) {
          NodeFS.chmodSync(gitPath, 0o600);
        }
        NodeFS.rmSync(root, { recursive: true, force: true });
      }),
  );

describe("resolveGitWorktreePath", () => {
  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a main checkout as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a directory outside a repository", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("no-repo");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a submodule as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("submodule");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a .git file without a usable gitdir pointer", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("unparseable-git-file");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("bare-repo-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree whose common dir is not named .git", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("custom-common-dir-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree from a relative gitdir pointer", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("relative-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree from a Windows gitdir pointer", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("windows-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a gitdir with nothing before `worktrees`", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("shallow-gitdir");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops at a repository nested inside a worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("nested-checkout");
      assert.equal(yield* resolveGitWorktreePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!canDenyReads)(
    "fails instead of reporting `not a worktree` when .git cannot be read",
    () =>
      Effect.gen(function* () {
        const { nested } = yield* makeRepo("unreadable-git-file");
        // The whole point: an unreadable pointer is not an answer. Reporting
        // `undefined` would send the caller at the shared home and its live
        // database, which is the outcome this module exists to prevent.
        const error = yield* Effect.flip(resolveGitWorktreePath(nested));
        assert.notEqual(error.reason._tag, "NotFound");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorktreeT3Home", () => {
  it.effect("answers with .t3 before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorktreeT3Home(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".t3"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers with undefined outside a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveWorktreeT3Home(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!canDenyReads)("propagates an unreadable .git rather than falling back", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("unreadable-git-file");
      const error = yield* Effect.flip(resolveWorktreeT3Home(nested));
      assert.notEqual(error.reason._tag, "NotFound");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

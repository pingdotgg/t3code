// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git fixtures are prepared independently of the Effect process code under test.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  describeManifestRoots,
  gitFailureReason,
  parseRepositoryStatus,
  pullManifestRepositories,
  resolveManifestRepository,
} from "./manifestRepositories.ts";

const git = (directory: string, ...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3 manifest pull " });
  const upstream = path.join(home, "upstream");
  const root = path.join(home, "manifests");
  const checkout = path.join(root, "app");
  yield* fs.makeDirectory(upstream);
  yield* fs.makeDirectory(root);
  git(upstream, "init", "-b", "main");
  yield* fs.makeDirectory(path.join(upstream, "agents"));
  const manifest = path.join(upstream, "agents", "agent.yaml");
  yield* fs.writeFileString(manifest, "metadata:\n  name: original\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "initial");
  git(root, "clone", upstream, checkout);
  const advance = Effect.gen(function* () {
    yield* fs.writeFileString(manifest, "metadata:\n  name: updated\n");
    yield* fs.writeFileString(
      path.join(upstream, "agents", "agent.nested.yaml"),
      "metadata:\n  name: nested\n",
    );
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "update manifests");
  });
  return { fs, path, home, upstream, root, checkout, advance };
});

describe("manifestRepositories", () => {
  it.effect(
    "identifies actual checkouts, nested folders, and worktrees without treating parent folders as repositories",
    () =>
      Effect.gen(function* () {
        const { checkout, root, home, fs, path } = yield* fixture;
        const repository = yield* resolveManifestRepository(checkout);
        assert.isNotNull(repository);
        assert.strictEqual(
          yield* resolveManifestRepository(path.join(checkout, "agents")),
          repository,
        );
        assert.strictEqual(yield* resolveManifestRepository(root), null);
        const fake = path.join(home, "fake");
        yield* fs.makeDirectory(path.join(fake, ".git"), { recursive: true });
        assert.strictEqual(yield* resolveManifestRepository(fake), null);
        const worktree = path.join(home, "linked");
        git(checkout, "worktree", "add", "-b", "linked", worktree);
        const linkedRepository = yield* resolveManifestRepository(worktree);
        assert.isNotNull(linkedRepository);
        assert.notStrictEqual(linkedRepository, repository);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("pulls multiple repositories under a manifest folder and discovers new variants", () =>
    Effect.gen(function* () {
      const { root, checkout, upstream, advance, fs, path } = yield* fixture;
      const other = path.join(root, "other");
      git(root, "clone", upstream, other);
      yield* advance;
      const pulled = yield* pullManifestRepositories([root]);
      assert.deepStrictEqual(
        pulled.map(({ outcome, commits, error }) => ({ outcome, commits, error })),
        [
          { outcome: "updated", commits: 1, error: null },
          { outcome: "updated", commits: 1, error: null },
        ],
      );
      for (const repo of [checkout, other]) {
        assert.strictEqual(git(repo, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
        assert.isTrue(yield* fs.exists(path.join(repo, "agents", "agent.nested.yaml")));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("pulls when the configured folder is inside a repository", () =>
    Effect.gen(function* () {
      const { checkout, upstream, advance, path } = yield* fixture;
      yield* advance;
      yield* pullManifestRepositories([path.join(checkout, "agents")]);
      assert.strictEqual(git(checkout, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
      const again = yield* pullManifestRepositories([checkout]);
      assert.strictEqual(again[0]?.outcome, "up-to-date");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "leaves local edits in place when they block the pull, even with autostash configured",
    () =>
      Effect.gen(function* () {
        const { checkout, advance, fs, path } = yield* fixture;
        git(checkout, "config", "pull.rebase", "true");
        git(checkout, "config", "rebase.autoStash", "true");
        const manifest = path.join(checkout, "agents", "agent.yaml");
        const head = git(checkout, "rev-parse", "HEAD");
        yield* fs.writeFileString(manifest, "local changes\n");
        yield* advance;
        const [result] = yield* pullManifestRepositories([checkout]);
        assert.strictEqual(result?.outcome, "failed");
        assert.match(result?.error ?? "", /local changes/);
        assert.strictEqual(git(checkout, "rev-parse", "HEAD"), head);
        assert.strictEqual(yield* fs.readFileString(manifest), "local changes\n");
        assert.strictEqual(git(checkout, "stash", "list"), "");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses divergent history without merging or rebasing local commits", () =>
    Effect.gen(function* () {
      const { checkout, advance, fs, path } = yield* fixture;
      yield* fs.writeFileString(path.join(checkout, "local.txt"), "local\n");
      git(checkout, "add", ".");
      git(checkout, "commit", "-m", "local work");
      const head = git(checkout, "rev-parse", "HEAD");
      yield* advance;
      const [result] = yield* pullManifestRepositories([checkout]);
      assert.strictEqual(result?.outcome, "failed");
      assert.strictEqual(git(checkout, "rev-parse", "HEAD"), head);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports folders without Git repositories", () =>
    Effect.gen(function* () {
      const { home, fs, path } = yield* fixture;
      const loose = path.join(home, "loose");
      yield* fs.makeDirectory(loose);
      yield* fs.writeFileString(path.join(loose, "agent.yaml"), "metadata:\n  name: loose\n");
      const result = yield* Effect.result(pullManifestRepositories([loose]));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.message, `No Git repositories found in ${loose}.`);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps pulling the other repositories when one fails", () =>
    Effect.gen(function* () {
      const { root, checkout, upstream, advance, fs, path } = yield* fixture;
      const other = path.join(root, "other");
      git(root, "clone", upstream, other);
      yield* fs.writeFileString(path.join(checkout, "agents", "agent.yaml"), "local\n");
      yield* advance;
      const pulled = yield* pullManifestRepositories([root]);
      assert.deepStrictEqual(
        pulled.map((result) => result.outcome),
        ["failed", "updated"],
      );
      assert.strictEqual(git(other, "rev-parse", "HEAD"), git(upstream, "rev-parse", "HEAD"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("describes manifests, local changes, and commits behind after a fetch", () =>
    Effect.gen(function* () {
      const { root, checkout, advance, fs, path, home } = yield* fixture;
      yield* fs.writeFileString(path.join(checkout, "scratch.txt"), "scratch\n");
      yield* advance;
      const missing = path.join(home, "missing");
      const [local, fetched, gone] = [
        ...(yield* describeManifestRoots([root], { fetch: false })),
        ...(yield* describeManifestRoots([root, missing], { fetch: true })),
      ];
      assert.strictEqual(local?.manifests, 1);
      assert.deepStrictEqual(
        local?.repositories.map(({ branch, upstream, changes, ahead, behind }) => ({
          branch,
          upstream,
          changes,
          ahead,
          behind,
        })),
        [{ branch: "main", upstream: "origin/main", changes: 1, ahead: 0, behind: 0 }],
      );
      assert.strictEqual(fetched?.repositories[0]?.behind, 1);
      assert.strictEqual(fetched?.repositories[0]?.fetchError, null);
      assert.deepStrictEqual(gone, {
        directory: missing,
        exists: false,
        manifests: 0,
        repositories: [],
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("parseRepositoryStatus", () => {
  it("reads a detached HEAD without an upstream", () => {
    assert.deepStrictEqual(
      parseRepositoryStatus("/repo", "# branch.oid abc\n# branch.head (detached)\n? new.txt"),
      { path: "/repo", branch: null, upstream: null, changes: 1, ahead: null, behind: null },
    );
  });

  it("does not invent a comparison with an upstream git could not find", () => {
    assert.deepStrictEqual(
      parseRepositoryStatus(
        "/repo",
        "# branch.oid abc\n# branch.head main\n# branch.upstream origin/gone",
      ),
      {
        path: "/repo",
        branch: "main",
        upstream: "origin/gone",
        changes: 0,
        ahead: null,
        behind: null,
      },
    );
  });
});

describe("gitFailureReason", () => {
  it("prefers git's fatal or error line over hints", () => {
    assert.strictEqual(
      gitFailureReason(
        "hint: Diverging branches can't be fast-forwarded\nfatal: Not possible to fast-forward, aborting.",
      ),
      "Not possible to fast-forward, aborting.",
    );
  });

  it("names the files git lists after a colon", () => {
    assert.strictEqual(
      gitFailureReason(
        "error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\n\tagents/agent.yaml\nPlease commit your changes or stash them before you merge.\nAborting",
      ),
      "Your local changes to the following files would be overwritten by merge: README.md, agents/agent.yaml",
    );
  });

  it("uses the first line of an unprefixed message", () => {
    assert.strictEqual(
      gitFailureReason(
        "There is no tracking information for the current branch.\nPlease specify which branch.",
      ),
      "There is no tracking information for the current branch.",
    );
  });
});

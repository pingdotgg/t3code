import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import {
  commitId,
  describeJj,
  runGit,
  runJj,
  withJjRepo,
  type JjRepoFixture,
} from "../vcs/testing/JjTestSupport.ts";
import { inspectJjStorageCleanup, removeJjStorageCleanup } from "./JjStorageCleanup.ts";
import { workspaceNameForRef } from "./JjWorkspaces.ts";

const bookmark = "feature/cleanup";
const withWorkspace = <A, E>(
  use: (
    repo: JjRepoFixture & { readonly cwd: string },
  ) => Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer>>,
) =>
  withJjRepo({ prefix: "t3-jj-storage-cleanup-", seed: true }, (repo) =>
    Effect.gen(function* () {
      const cwd = repo.path.join(repo.base, "workspace");
      yield* runJj(repo.root, ["bookmark", "create", bookmark, "-r", "main"]);
      yield* runJj(repo.root, [
        "workspace",
        "add",
        "--colocate",
        "--name",
        workspaceNameForRef(bookmark),
        "-r",
        bookmark,
        cwd,
      ]);
      return yield* use({ ...repo, cwd });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describeJj("JjStorageCleanup", () => {
  it.effect("removes an idle empty workspace on its bookmarked parent", () =>
    withWorkspace(({ cwd, root, driver, fileSystem }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.equal(inspected.commitId, yield* commitId(cwd, "@-"));
        assert.equal(inspected.defaultBranch, "main");
        assert.isTrue(inspected.integrated);
        assert.equal(inspected.mainWorkspaceRoot, root);
        assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isFalse(yield* fileSystem.exists(cwd));
        assert.isFalse((yield* driver.listWorkspaces(root)).some((entry) => entry.root === cwd));
        assert.isTrue(yield* fileSystem.exists(root));
      }),
    ),
  );

  it.effect("does not snapshot untracked main-workspace files during removal", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runJj(root, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
        yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "main-only secret");
        const before = yield* commitId(root, "@");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.equal(yield* commitId(root, "@"), before);
        assert.notInclude(
          yield* runJj(root, ["--ignore-working-copy", "file", "list"]),
          "secret.txt",
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(root, "secret.txt")),
          "main-only secret",
        );
      }),
    ),
  );

  it.effect("keeps ignored target files even when the main Git index tracks their path", () =>
    withWorkspace(({ cwd, root, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runGit(root, ["add", "seed.txt"]);
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "seed.txt\n");
        yield* runJj(cwd, ["file", "untrack", "seed.txt"]);
        yield* runJj(cwd, ["commit", "-m", "stop tracking seed"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        assert.include(
          (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
          "has ignored files (seed.txt)",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark)).reason);
      }),
    ),
  );

  it.effect("keeps a dirty working-copy commit", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "seed.txt"), "agent changes\n");
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNotNull(inspected.reason);
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "seed.txt")),
          "agent changes\n",
        );
      }),
    ),
  );

  it.effect(
    "keeps nonignored untracked files even with tracked-changes and auto-track disabled",
    () =>
      withWorkspace(({ cwd, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* runJj(cwd, ["config", "set", "--repo", "snapshot.auto-track", "none()"]);
          yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "keep me\n");
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "tracked-changes");
          assert.isNotNull(inspected.reason);
          assert.isNotNull(
            yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId, "tracked-changes"),
          );
          assert.isTrue(yield* fileSystem.exists(path.join(cwd, "untracked.txt")));
          assert.notInclude(
            yield* runJj(cwd, ["--ignore-working-copy", "file", "list"]),
            "untracked.txt",
          );
        }),
      ),
  );

  it.effect("keeps oversized untracked files that jj refuses to snapshot", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* runJj(cwd, ["config", "set", "--repo", "snapshot.max-new-file-size", "1"]);
        yield* fileSystem.writeFileString(
          path.join(cwd, "oversized.txt"),
          "too large to snapshot\n",
        );
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark, "tracked-changes");
        assert.isNotNull(inspected.reason);
        assert.isTrue(yield* fileSystem.exists(path.join(cwd, "oversized.txt")));
      }),
    ),
  );

  it.effect("keeps nonempty ancestors stranded behind an empty working copy", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "stranded.txt"), "unbookmarked commit\n");
        yield* runJj(cwd, ["commit", "-m", "stranded work"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.equal(inspected.reason, "has commits not reachable from any bookmark");
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect("keeps empty ancestors that no bookmark protects", () =>
    withWorkspace(({ cwd }) =>
      Effect.gen(function* () {
        yield* runJj(cwd, ["new"]);
        assert.equal(
          (yield* inspectJjStorageCleanup(cwd, bookmark)).reason,
          "has commits not reachable from any bookmark",
        );
      }),
    ),
  );

  it.effect("allows ancestry protected only by a remote bookmark", () =>
    withWorkspace(({ cwd, root, remotePath, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(remotePath);
        yield* runGit(remotePath, ["init", "--bare", "--initial-branch=main"]);
        yield* runJj(root, ["git", "remote", "add", "origin", remotePath]);
        yield* fileSystem.writeFileString(path.join(cwd, "remote-work.txt"), "published work\n");
        yield* runJj(cwd, ["commit", "-m", "published work"]);
        yield* runJj(cwd, ["bookmark", "create", "published", "-r", "@-"]);
        yield* runJj(cwd, ["git", "push", "--bookmark", "published", "--remote", "origin"]);
        yield* runJj(cwd, ["bookmark", "delete", "published"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
      }),
    ),
  );

  it.effect("allows bookmarked commits not integrated into main", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, "protected.txt"), "bookmarked work\n");
        yield* runJj(cwd, ["commit", "-m", "protected work"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        assert.isFalse(inspected.integrated);
      }),
    ),
  );

  it.effect("never removes the main workspace", () =>
    withWorkspace(({ root, fileSystem }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(root, "main");
        assert.equal(inspected.reason, "is the main Jujutsu workspace");
        assert.isNotNull(yield* removeJjStorageCleanup(root, "main", inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(root));
      }),
    ),
  );

  it.effect("refuses a different managed bookmark", () =>
    withWorkspace(({ cwd }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, "other-bookmark");
        assert.equal(inspected.reason, "workspace no longer belongs to the expected bookmark");
      }),
    ),
  );

  it.effect("rechecks files written after inspection", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        assert.isNull(inspected.reason);
        yield* fileSystem.writeFileString(path.join(cwd, "late.txt"), "late work\n");
        assert.isNotNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
        assert.isTrue(yield* fileSystem.exists(path.join(cwd, "late.txt")));
      }),
    ),
  );

  it.effect("rechecks an otherwise clean bookmarked parent changed after inspection", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
        yield* fileSystem.writeFileString(path.join(cwd, "committed.txt"), "new head\n");
        yield* runJj(cwd, ["commit", "-m", "new bookmarked head"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        assert.equal(
          yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId),
          "workspace changed since inspection",
        );
        assert.isTrue(yield* fileSystem.exists(cwd));
      }),
    ),
  );

  it.effect(
    "ignores empty directories and keeps ignored-only directories only for any-local-files",
    () =>
      withWorkspace(({ cwd, fileSystem, path }) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "*.cache\n");
          yield* runJj(cwd, ["commit", "-m", "ignore cache files"]);
          yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
          yield* fileSystem.makeDirectory(path.join(cwd, "emptydir"));
          assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason);
          yield* fileSystem.makeDirectory(path.join(cwd, "onlyignored", "nested"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(cwd, "onlyignored", "nested", "data.cache"),
            "local cache data",
          );
          const inspected = yield* inspectJjStorageCleanup(cwd, bookmark);
          assert.isNull(inspected.reason);
          assert.include(
            (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
            "has ignored files",
          );
          assert.isNull(yield* removeJjStorageCleanup(cwd, bookmark, inspected.commitId));
          assert.isFalse(yield* fileSystem.exists(cwd));
        }),
      ),
  );

  it.effect("keeps ignored files only for any-local-files, except node_modules", () =>
    withWorkspace(({ cwd, fileSystem, path }) =>
      Effect.gen(function* () {
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "cache/\nnode_modules/\n");
        yield* runJj(cwd, ["commit", "-m", "ignore generated files"]);
        yield* runJj(cwd, ["bookmark", "move", bookmark, "--to", "@-"]);
        yield* fileSystem.makeDirectory(path.join(cwd, "node_modules"));
        yield* fileSystem.writeFileString(
          path.join(cwd, "node_modules", "dependency"),
          "generated",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason);
        yield* fileSystem.makeDirectory(path.join(cwd, "cache"));
        yield* fileSystem.writeFileString(path.join(cwd, "cache", "precious"), "local data");
        assert.include(
          (yield* inspectJjStorageCleanup(cwd, bookmark, "any-local-files")).reason!,
          "has ignored files",
        );
        assert.isNull((yield* inspectJjStorageCleanup(cwd, bookmark)).reason);
      }),
    ),
  );
});

import { assert, it } from "@effect/vitest";
import type {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { resolveWorkspaceRefName } from "../jj/JjStatus.ts";
import { workspaceNameForRef } from "../jj/JjWorkspaces.ts";
import { commitId, describeJj, runGit, runJj, withJjRepo, write } from "./testing/JjTestSupport.ts";

interface RepoContext {
  readonly getDiffPreview: (
    input: ReviewDiffPreviewInput,
  ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>;
  readonly getDiffFileContents: (
    input: ReviewDiffFileContentsInput,
  ) => Effect.Effect<ReviewDiffFileContentsResult, VcsError>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly base: string;
  readonly root: string;
}

const withRepo = <A, E>(
  use: (context: RepoContext) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  withJjRepo({ prefix: "t3-jj-review-" }, (repo) => {
    const getDiffPreview = repo.driver.getDiffPreview;
    const getDiffFileContents = repo.driver.getDiffFileContents;
    if (!getDiffPreview || !getDiffFileContents) {
      assert.fail("The Jujutsu driver exposes no review diff operations.");
    }
    return use({ ...repo, getDiffPreview, getDiffFileContents });
  });

/** Publishes `main` through the colocated Git store, so `main@origin` and `trunk()` both resolve. */
const addOriginWithMain = (context: RepoContext) =>
  Effect.gen(function* () {
    const origin = context.path.join(context.base, "origin.git");
    yield* context.fileSystem.makeDirectory(origin, { recursive: true });
    yield* runGit(origin, ["init", "--bare", "--quiet"]);
    yield* runJj(context.root, ["bookmark", "create", "main", "-r", "@-"]);
    yield* runGit(context.root, ["remote", "add", "origin", origin]);
    yield* runGit(context.root, ["push", "--quiet", "origin", "main"]);
    yield* runJj(context.root, ["git", "fetch"]);
  });

describeJj("JjReviewDiff branch totals", () => {
  it.effect("uses the stored upstream base instead of local and origin shadows for preview and totals", () =>
    withJjRepo({ prefix: "t3-jj-review-upstream-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        const upstreamPath = repo.path.join(repo.base, "upstream.git");
        yield* runGit(repo.root, ["init", "--bare", "--quiet", upstreamPath]);
        yield* runGit(repo.root, ["remote", "add", "upstream", upstreamPath]);
        yield* write(repo, "upstream-only.txt", "upstream base\n");
        yield* runJj(repo.root, ["commit", "-m", "upstream base"]);
        yield* runJj(repo.root, ["bookmark", "create", "release", "-r", "@-"]);
        yield* runJj(repo.root, ["git", "push", "--remote", "upstream", "--bookmark", "release"]);
        const upstream = yield* commitId(repo.root, "release@upstream");
        yield* runGit(repo.root, [
          "update-ref",
          "refs/remotes/origin/release",
          yield* commitId(repo.root, "main"),
        ]);
        yield* runJj(repo.root, [
          "bookmark",
          "set",
          "release",
          "-r",
          "main",
          "--allow-backwards",
        ]);
        yield* runJj(repo.root, ["bookmark", "create", "topic", "-r", upstream]);
        const cwd = repo.path.join(repo.base, "topic");
        yield* runJj(repo.root, [
          "workspace",
          "add",
          "--colocate",
          "--name",
          workspaceNameForRef("topic"),
          "-r",
          "topic",
          cwd,
        ]);
        yield* runGit(repo.root, ["config", "branch.topic.gh-merge-base", "release"]);
        yield* runGit(repo.root, [
          "config",
          "branch.topic.t3-merge-base-ref",
          "refs/remotes/upstream/release",
        ]);
        yield* repo.fileSystem.writeFileString(repo.path.join(cwd, "feature.txt"), "feature\n");
        const preview = yield* repo.driver.getDiffPreview!({ cwd });
        const source = preview.sources[1]!;
        assert.equal(source.title, "Against upstream/release");
        assert.equal(source.baseRef, upstream);
        assert.include(source.diff, "+feature");
        assert.notInclude(source.diff, "upstream-only.txt");
        const change = yield* repo.driver.currentChange(cwd);
        for (const input of [{ cwd, change }, { cwd, change, refName: "topic" }]) {
          const totals = yield* repo.driver.readBranchChangeTotals(input);
          assert.deepStrictEqual(totals, {
            baseRef: "upstream/release",
            insertions: 1,
            deletions: 0,
          });
        }
      }),
    ),
  );

  for (const childRef of ["zzz-child", "aaa-child"]) {
    it.effect(`uses the managed bookmark's configured review base for ${childRef}`, () =>
      withJjRepo({ prefix: "t3-jj-review-workspace-", seed: true }, (repo) =>
        Effect.gen(function* () {
          for (const base of ["base-main", "base-child"]) {
            yield* runJj(repo.root, ["bookmark", "create", base, "-r", "main"]);
          }
          yield* write(repo, "shared.txt", "shared\n");
          yield* runJj(repo.root, ["commit", "-m", "shared head"]);
          yield* runJj(repo.root, ["bookmark", "set", "main", "-r", "@-"]);
          yield* runJj(repo.root, ["bookmark", "create", childRef, "-r", "main"]);
          yield* runGit(repo.root, ["config", "branch.main.gh-merge-base", "refs/heads/base-main"]);
          yield* runGit(repo.root, [
            "config",
            `branch.${childRef}.gh-merge-base`,
            "refs/heads/base-child",
          ]);
          const child = repo.path.join(repo.base, "child");
          yield* runJj(repo.root, [
            "workspace",
            "add",
            "--colocate",
            "--name",
            workspaceNameForRef(childRef),
            "-r",
            childRef,
            child,
          ]);
          for (const [cwd, expectedRef, expectedBase] of [
            [repo.root, "main", "base-main"],
            [child, childRef, "base-child"],
          ] as const) {
            const preview = yield* repo.driver.getDiffPreview!({ cwd });
            assert.equal(preview.sources[1]!.title, `Against ${expectedBase}`);
            const segment = yield* repo.driver.currentSegment(cwd);
            const refName = yield* resolveWorkspaceRefName(repo.driver, cwd, segment);
            assert.equal(refName, expectedRef);
            const change = yield* repo.driver.currentChange(cwd);
            for (const input of [
              { cwd, change },
              { cwd, change, refName },
            ]) {
              const totals = yield* repo.driver.readBranchChangeTotals(input);
              assert.isDefined(totals);
              assert.equal(totals.baseRef, expectedBase);
              assert.equal(totals.insertions, 1);
            }
          }
        }),
      ),
    );
  }

  it.effect("counts the supplied snapshot rather than snapshotting newer working-copy edits", () =>
    withJjRepo({ prefix: "t3-jj-review-totals-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        yield* write(repo, "agent.txt", "captured\n");
        const change = yield* repo.driver.currentChange(repo.root);
        yield* write(repo, "agent.txt", "captured\nnot captured\n");

        const totals = yield* repo.driver.readBranchChangeTotals({
          cwd: repo.root,
          change,
        });

        assert.deepStrictEqual(totals, {
          baseRef: "origin/main",
          insertions: 1,
          deletions: 0,
        });
      }),
    ),
  );
});

describeJj("JjReviewDiff preview", () => {
  it.effect("keeps complete statistics and expands files beyond the preview limit", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "base.txt", "base\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* addOriginWithMain(context);
        yield* write(context, "a-large.txt", "large line\n".repeat(20_000));
        yield* write(context, "z-last.txt", "last\n");
        const preview = yield* context.getDiffPreview({ cwd: context.root });
        const source = preview.sources[0]!;
        assert.isTrue(source.truncated);
        assert.deepEqual(source.files, [
          { path: "a-large.txt", previousPath: null, additions: 20_000, deletions: 0 },
          { path: "z-last.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        yield* write(context, "z-last.txt", "last\nanother\n");
        const changed = yield* context.getDiffPreview({ cwd: context.root });
        assert.equal(changed.sources[0]!.diff, source.diff);
        assert.notEqual(changed.sources[0]!.diffHash, source.diffHash);
        const expanded = yield* context.getDiffPreview({
          cwd: context.root,
          file: { path: "a-large.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.isFalse(expanded.sources[0]!.truncated);
        assert.notInclude(expanded.sources[0]!.diff, "z-last.txt");
        assert.deepEqual(expanded.sources[1]!.files, []);
        assert.equal(expanded.sources[1]!.diff, "");
      }),
    ),
  );

  it.effect("filters a renamed file literally and keeps NUL-delimited paths intact", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        const oldPath = "old\tname.txt";
        const newPath = "new\n[name].txt";
        yield* write(context, oldPath, "same content\n".repeat(20));
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* addOriginWithMain(context);
        yield* context.fileSystem.rename(
          context.path.join(context.root, oldPath),
          context.path.join(context.root, newPath),
        );
        yield* write(context, "other.txt", "other\n");
        const preview = yield* context.getDiffPreview({
          cwd: context.root,
          file: { path: newPath, previousPath: oldPath, sourceKind: "branch-range" },
        });
        assert.equal(preview.sources[0]!.diff, "");
        assert.deepEqual(preview.sources[1]!.files, [
          { path: newPath, previousPath: oldPath, additions: 0, deletions: 0 },
        ]);
        assert.notInclude(preview.sources[1]!.diff, "other.txt");
      }),
    ),
  );

  it.effect("returns a working-copy source and a base source against the default bookmark", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* addOriginWithMain(context);
        yield* write(context, "a.txt", "v2\n");
        yield* write(context, "untracked.txt", "new file\n");

        const preview = yield* context.getDiffPreview({ cwd: context.root });

        const [workingTree, branchRange] = preview.sources;
        assert.equal(preview.sources.length, 2);
        assert.deepInclude(workingTree, {
          id: "working-tree",
          kind: "working-tree",
          title: "Working copy",
          baseRef: "@-",
          headRef: "@",
          truncated: false,
        });
        // jj auto-snapshots, so an untracked file needs no index dance to reach the diff.
        assert.include(workingTree?.diff ?? "", "untracked.txt");
        assert.include(workingTree?.diff ?? "", "-v1");
        assert.include(workingTree?.diff ?? "", "+v2");
        assert.deepInclude(branchRange, {
          id: "branch-range",
          kind: "branch-range",
          title: "Against origin/main",
          baseRef: yield* commitId(context.root, "main@origin"),
          headRef: "@",
        });
        assert.include(branchRange?.diff ?? "", "+v2");

        // An explicit remote base ref reaches the resolver in jj's own revset form.
        const againstRemote = yield* context.getDiffPreview({
          cwd: context.root,
          baseRef: "origin/main",
        });
        assert.deepInclude(againstRemote.sources[1], {
          title: "Against origin/main",
          baseRef: yield* commitId(context.root, "main@origin"),
        });
      }),
    ),
  );

  it.effect("succeeds with an empty base source when no base resolves", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");

        const preview = yield* context.getDiffPreview({ cwd: context.root });

        const branchRange = preview.sources[1];
        assert.deepInclude(branchRange, {
          id: "branch-range",
          kind: "branch-range",
          title: "Against base branch",
          baseRef: null,
          diff: "",
          truncated: false,
        });
        assert.include(preview.sources[0]?.diff ?? "", "+v1");
      }),
    ),
  );

  it.effect("marks a conflicted working copy in the source title", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "base\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        const baseCommit = yield* commitId(context.root, "@-");
        yield* write(context, "a.txt", "one\n");
        yield* runJj(context.root, ["commit", "-m", "one"]);
        const sideOne = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", baseCommit]);
        yield* write(context, "a.txt", "two\n");
        yield* runJj(context.root, ["commit", "-m", "two"]);
        const sideTwo = yield* commitId(context.root, "@-");
        yield* runJj(context.root, ["new", sideOne, sideTwo]);

        const preview = yield* context.getDiffPreview({ cwd: context.root });

        assert.equal(preview.sources[0]?.title, "Working copy (conflicted)");
        assert.notInclude(preview.sources[0]?.diff ?? "", ".jjconflict-");
        assert.notInclude(preview.sources[0]?.diff ?? "", "JJ-CONFLICT-README");
      }),
    ),
  );
});

describeJj("JjReviewDiff file contents", () => {
  it.effect("rejects binary expansion without reporting a successful command as failed", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "binary.bin", "before\0binary");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* write(context, "binary.bin", "after\0binary");
        const error = yield* context
          .getDiffFileContents({
            cwd: context.root,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "@-",
            headRef: "@",
            oldPath: "binary.bin",
            newPath: "binary.bin",
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "VcsUnsupportedOperationError");
        assert.include(error.message, "Cannot expand binary file 'binary.bin'.");
      }),
    ),
  );

  it.effect("expands changed, new, deleted, and renamed files from the working copy", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        const renamedBody = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
        yield* write(context, "changed.txt", "v1\n");
        yield* write(context, "deleted.txt", "gone soon\n");
        yield* write(context, "rename-old.txt", renamedBody);
        yield* runJj(context.root, ["commit", "-m", "base"]);

        yield* write(context, "changed.txt", "v2\n");
        yield* write(context, "added.txt", "brand new\n");
        yield* context.fileSystem.remove(context.path.join(context.root, "deleted.txt"));
        yield* context.fileSystem.rename(
          context.path.join(context.root, "rename-old.txt"),
          context.path.join(context.root, "rename-new.txt"),
        );

        const expand = (
          input: Pick<ReviewDiffFileContentsInput, "changeType" | "oldPath" | "newPath">,
        ) =>
          context.getDiffFileContents({
            cwd: context.root,
            sourceKind: "working-tree",
            baseRef: "@-",
            headRef: "@",
            ...input,
          });

        assert.deepStrictEqual(
          yield* expand({ changeType: "change", oldPath: "changed.txt", newPath: "changed.txt" }),
          { oldContents: "v1\n", newContents: "v2\n" },
        );
        assert.deepStrictEqual(
          yield* expand({ changeType: "new", oldPath: "added.txt", newPath: "added.txt" }),
          { oldContents: "", newContents: "brand new\n" },
        );
        assert.deepStrictEqual(
          yield* expand({ changeType: "deleted", oldPath: "deleted.txt", newPath: "deleted.txt" }),
          { oldContents: "gone soon\n", newContents: "" },
        );
        assert.deepStrictEqual(
          yield* expand({
            changeType: "rename-pure",
            oldPath: "rename-old.txt",
            newPath: "rename-new.txt",
          }),
          { oldContents: renamedBody, newContents: renamedBody },
        );
      }),
    ),
  );

  it.effect("expands a branch-range file against the commit ids the preview handed out", () =>
    withRepo(
      Effect.fnUntraced(function* (context) {
        yield* write(context, "a.txt", "v1\n");
        yield* runJj(context.root, ["commit", "-m", "base"]);
        yield* addOriginWithMain(context);
        yield* write(context, "a.txt", "v2\n");

        const preview = yield* context.getDiffPreview({ cwd: context.root });
        const branchRange = preview.sources[1];

        assert.deepStrictEqual(
          yield* context.getDiffFileContents({
            cwd: context.root,
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: branchRange?.baseRef ?? null,
            headRef: branchRange?.headRef ?? null,
            oldPath: "a.txt",
            newPath: "a.txt",
          }),
          { oldContents: "v1\n", newContents: "v2\n" },
        );
      }),
    ),
  );
});

describeJj("JjReviewDiff merge baselines", () => {
  for (const configured of [false, true]) {
    it.effect(
      `does not shadow a ${configured ? "configured" : "explicit"} remote base with a local bookmark`,
      () =>
        withJjRepo({ prefix: "t3-jj-review-shadow-", withRemote: true }, (repo) =>
          Effect.gen(function* () {
            const remoteBase = yield* commitId(repo.root, "main@origin");
            yield* write(repo, "committed.txt", "committed\n");
            yield* runJj(repo.root, ["commit", "-m", "local ahead"]);
            yield* runJj(repo.root, ["bookmark", "create", "origin/main", "-r", "@-"]);
            yield* write(repo, "working.txt", "working\n");
            if (configured) {
              yield* runGit(repo.root, ["config", "branch.main.gh-merge-base", "origin/main"]);
              yield* runGit(repo.root, [
                "config",
                "branch.origin/main.gh-merge-base",
                "origin/main",
              ]);
            }
            const preview = yield* repo.driver.getDiffPreview!({
              cwd: repo.root,
              ...(configured ? {} : { baseRef: "origin/main" }),
            });
            const source = preview.sources[1]!;
            assert.equal(source.baseRef, remoteBase);
            assert.deepStrictEqual(
              source.files?.map((file) => file.path),
              ["committed.txt", "working.txt"],
            );
            if (configured) {
              assert.deepStrictEqual(
                yield* repo.driver.readBranchChangeTotals({
                  cwd: repo.root,
                  change: yield* repo.driver.currentChange(repo.root),
                }),
                { baseRef: "origin/main", insertions: 2, deletions: 0 },
              );
            }
            const local = yield* repo.driver.getDiffPreview!({
              cwd: repo.root,
              baseRef: "refs/heads/origin/main",
            });
            assert.deepStrictEqual(
              local.sources[1]!.files?.map((file) => file.path),
              ["working.txt"],
            );
          }),
        ),
    );
  }
  it.effect(
    "falls back to a local remote-qualified spelling only when the remote bookmark is absent",
    () =>
      withJjRepo({ prefix: "t3-jj-review-remote-fallback-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          yield* runJj(repo.root, ["bookmark", "create", "origin/local-only", "-r", "@-"]);
          const base = yield* commitId(repo.root, "@-");
          yield* write(repo, "working.txt", "working\n");
          const preview = yield* repo.driver.getDiffPreview!({
            cwd: repo.root,
            baseRef: "origin/local-only",
          });
          assert.equal(preview.sources[1]!.baseRef, base);
          assert.include(
            preview.sources[1]!.files!.map((file) => file.path),
            "working.txt",
          );
          const explicitRemote = yield* repo.driver.getDiffPreview!({
            cwd: repo.root,
            baseRef: "refs/remotes/origin/local-only",
          });
          assert.isNull(explicitRemote.sources[1]!.baseRef);
        }),
      ),
  );
  it.effect("uses a configured stacked base for totals, preview, and diverged expansion", () =>
    withJjRepo({ prefix: "t3-jj-review-base-", withRemote: true }, (repo) =>
      Effect.gen(function* () {
        yield* write(repo, "shared.txt", "original\n");
        yield* runJj(repo.root, ["commit", "-m", "common"]);
        yield* runJj(repo.root, ["bookmark", "create", "stack", "-r", "@-"]);
        yield* write(repo, "feature.txt", "feature\n");
        yield* runJj(repo.root, ["commit", "-m", "feature"]);
        yield* runJj(repo.root, ["bookmark", "create", "topic", "-r", "@-"]);
        const head = yield* commitId(repo.root, "@");
        yield* runJj(repo.root, ["new", "stack"]);
        yield* write(repo, "shared.txt", "upstream\n");
        yield* runJj(repo.root, ["commit", "-m", "base advanced"]);
        yield* runJj(repo.root, ["bookmark", "set", "stack", "-r", "@-"]);
        yield* runJj(repo.root, ["edit", head]);
        yield* runGit(repo.root, ["config", "branch.topic.gh-merge-base", "refs/heads/stack"]);
        yield* write(repo, "shared.txt", "topic edit\n");
        const preview = yield* repo.driver.getDiffPreview!({ cwd: repo.root });
        const source = preview.sources[1]!;
        assert.equal(source.title, "Against stack");
        assert.notInclude(source.diff, "-upstream");
        const totals = yield* repo.driver.readBranchChangeTotals({
          cwd: repo.root,
          change: yield* repo.driver.currentChange(repo.root),
        });
        assert.deepStrictEqual(totals, { baseRef: "stack", insertions: 2, deletions: 1 });
        assert.deepStrictEqual(
          yield* repo.driver.getDiffFileContents!({
            cwd: repo.root,
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: source.baseRef,
            headRef: source.headRef,
            oldPath: "shared.txt",
            newPath: "shared.txt",
          }),
          { oldContents: "original\n", newContents: "topic edit\n" },
        );
        const explicit = yield* repo.driver.getDiffPreview!({ cwd: repo.root, baseRef: "main" });
        assert.equal(explicit.sources[1]?.title, "Against main");
      }),
    ),
  );

  it.effect(
    "excludes inherited second-parent files and expands merge edits, deletion, binary, and rename",
    () =>
      withRepo(
        Effect.fnUntraced(function* (context) {
          yield* write(context, "base.txt", "base\n");
          yield* runJj(context.root, ["commit", "-m", "base"]);
          const base = yield* commitId(context.root, "@-");
          yield* write(context, "left.txt", "left\n");
          yield* runJj(context.root, ["commit", "-m", "left"]);
          const left = yield* commitId(context.root, "@-");
          yield* runJj(context.root, ["new", base]);
          yield* write(context, "right.txt", "right\n");
          yield* write(context, "large.txt", "small\n");
          yield* write(context, "deleted.txt", "delete me\n");
          yield* write(context, "old name.txt", "rename me\n".repeat(20));
          yield* write(context, "binary.bin", "before\0binary");
          yield* runJj(context.root, ["commit", "-m", "right"]);
          const right = yield* commitId(context.root, "@-");
          yield* runJj(context.root, ["new", left, right]);
          const clean = yield* context.getDiffPreview({ cwd: context.root });
          assert.equal(clean.sources[0]?.diff, "");
          assert.deepStrictEqual(clean.sources[0]?.files, []);
          yield* write(context, "right.txt", "edited right");
          yield* context.fileSystem.remove(context.path.join(context.root, "deleted.txt"));
          yield* context.fileSystem.rename(
            context.path.join(context.root, "old name.txt"),
            context.path.join(context.root, "new name.txt"),
          );
          yield* write(context, "binary.bin", "after\0binary");
          const preview = yield* context.getDiffPreview({ cwd: context.root });
          assert.notInclude(preview.sources[0]!.diff, "left.txt");
          assert.include(preview.sources[0]!.diff, "-right");
          assert.equal(
            preview.sources[0]!.files?.find((file) => file.path === "new name.txt")?.previousPath,
            "old name.txt",
          );
          const nestedCwd = context.path.join(context.root, "sub");
          yield* context.fileSystem.makeDirectory(nestedCwd);
          const scoped = yield* context.getDiffPreview({
            cwd: nestedCwd,
            file: { sourceKind: "working-tree", path: "right.txt", previousPath: null },
          });
          assert.include(scoped.sources[0]!.diff, "-right");
          const expand = (
            oldPath: string,
            newPath: string,
            changeType: ReviewDiffFileContentsInput["changeType"],
          ) =>
            context.getDiffFileContents({
              cwd: nestedCwd,
              sourceKind: "working-tree",
              baseRef: "@-",
              headRef: "@",
              oldPath,
              newPath,
              changeType,
            });
          assert.deepStrictEqual(yield* expand("right.txt", "right.txt", "change"), {
            oldContents: "right\n",
            newContents: "edited right",
          });
          assert.deepStrictEqual(yield* expand("deleted.txt", "deleted.txt", "deleted"), {
            oldContents: "delete me\n",
            newContents: "",
          });
          assert.deepStrictEqual(yield* expand("old name.txt", "new name.txt", "rename-pure"), {
            oldContents: "rename me\n".repeat(20),
            newContents: "rename me\n".repeat(20),
          });
          yield* write(context, "new name.txt", `${"rename me\n".repeat(19)}edited name\n`);
          assert.deepStrictEqual(yield* expand("old name.txt", "new name.txt", "rename-changed"), {
            oldContents: "rename me\n".repeat(20),
            newContents: `${"rename me\n".repeat(19)}edited name\n`,
          });
          const binary = yield* expand("binary.bin", "binary.bin", "change").pipe(Effect.flip);
          assert.include(binary.message, "binary");
          assert.equal(binary._tag, "VcsUnsupportedOperationError");
          yield* write(context, "large.txt", "large line\n".repeat(200_000));
          assert.isTrue(yield* Effect.isFailure(expand("large.txt", "large.txt", "change")));
        }),
      ),
  );
});

describeJj("JjReviewDiff default-base consistency", () => {
  it.effect(
    "uses the same remote default in preview and totals even when a local default differs",
    () =>
      withJjRepo({ prefix: "t3-jj-review-default-", withRemote: true }, (repo) =>
        Effect.gen(function* () {
          yield* write(repo, "committed.txt", "committed\n");
          yield* runJj(repo.root, ["commit", "-m", "local main ahead"]);
          yield* runJj(repo.root, ["bookmark", "set", "main", "-r", "@-"]);
          yield* write(repo, "working.txt", "working\n");
          const preview = yield* repo.driver.getDiffPreview!({ cwd: repo.root });
          const totals = yield* repo.driver.readBranchChangeTotals({
            cwd: repo.root,
            change: yield* repo.driver.currentChange(repo.root),
          });
          assert.deepStrictEqual(totals, { baseRef: "origin/main", insertions: 2, deletions: 0 });
          assert.deepStrictEqual(
            preview.sources[1]!.files?.map((file) => file.path),
            ["committed.txt", "working.txt"],
          );
          const explicitLocal = yield* repo.driver.getDiffPreview!({
            cwd: repo.root,
            baseRef: "main",
          });
          assert.deepStrictEqual(
            explicitLocal.sources[1]!.files?.map((file) => file.path),
            ["working.txt"],
          );
          yield* runGit(repo.root, ["config", "branch.main.gh-merge-base", "refs/heads/main"]);
          const configuredLocal = yield* repo.driver.getDiffPreview!({ cwd: repo.root });
          assert.deepStrictEqual(
            configuredLocal.sources[1]!.files?.map((file) => file.path),
            ["working.txt"],
          );
          assert.deepStrictEqual(
            yield* repo.driver.readBranchChangeTotals({
              cwd: repo.root,
              change: yield* repo.driver.currentChange(repo.root),
            }),
            { baseRef: "main", insertions: 1, deletions: 0 },
          );
          yield* runGit(repo.root, ["config", "--unset", "branch.main.gh-merge-base"]);
          yield* runJj(repo.root, ["bookmark", "delete", "main"]);
          const remoteOnly = yield* repo.driver.getDiffPreview!({ cwd: repo.root });
          const remoteTotals = yield* repo.driver.readBranchChangeTotals({
            cwd: repo.root,
            change: yield* repo.driver.currentChange(repo.root),
          });
          assert.equal(remoteOnly.sources[1]!.files?.length, 2);
          assert.deepStrictEqual(remoteTotals, {
            baseRef: "origin/main",
            insertions: 2,
            deletions: 0,
          });
          assert.deepStrictEqual(
            yield* repo.driver.getDiffFileContents!({
              cwd: repo.root,
              sourceKind: "branch-range",
              baseRef: remoteOnly.sources[1]!.baseRef,
              headRef: "@",
              changeType: "new",
              oldPath: "committed.txt",
              newPath: "committed.txt",
            }),
            { oldContents: "", newContents: "committed\n" },
          );
          yield* runJj(repo.root, ["git", "remote", "remove", "origin"]);
          yield* runJj(repo.root, ["bookmark", "set", "main", "-r", "@-"]);
          const localFallback = yield* repo.driver.getDiffPreview!({ cwd: repo.root });
          const localTotals = yield* repo.driver.readBranchChangeTotals({
            cwd: repo.root,
            change: yield* repo.driver.currentChange(repo.root),
          });
          assert.deepStrictEqual(localTotals, { baseRef: "main", insertions: 1, deletions: 0 });
          assert.deepStrictEqual(
            localFallback.sources[1]!.files?.map((file) => file.path),
            ["working.txt"],
          );
        }),
      ),
  );
});

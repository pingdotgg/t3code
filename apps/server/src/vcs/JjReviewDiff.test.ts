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
          title: "Against main",
          baseRef: yield* commitId(context.root, "main"),
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

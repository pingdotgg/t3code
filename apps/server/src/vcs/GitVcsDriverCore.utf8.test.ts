import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-utf8-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-vcs-driver-utf8-test-" });
  });

const writeTextFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.utf8Test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

it.effect("keeps truncated multibyte output valid and within the byte budget", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "01-large-untracked.txt", `${"é".repeat(600_000)}\n`);

    const driver = yield* GitVcsDriver.GitVcsDriver;
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

    assert.isDefined(source);
    assert.isTrue(source.truncated);
    assert.include(source.diff, "01-large-untracked.txt");
    assert.notInclude(source.diff, "\uFFFD");
    assert.isAtMost(new TextEncoder().encode(source.diff).byteLength, 1024 * 1024);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps large tracked and untracked review diffs complete below one MiB", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const baseRef = yield* git(cwd, ["branch", "--show-current"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const lineCount = 16_000;
    const original = Array.from({ length: lineCount }, (_, index) => `before-${index}\n`).join("");
    const updated = Array.from({ length: lineCount }, (_, index) => `after-${index}\n`).join("");
    const sourceBefore = 'export const source = "before";\n';
    const sourceAfter = 'export const source = "after";\n';

    yield* writeTextFile(cwd, "01-large-review-file.txt", original);
    yield* writeTextFile(cwd, "02-source-file.ts", sourceBefore);
    yield* git(cwd, ["add", "01-large-review-file.txt", "02-source-file.ts"]);
    yield* git(cwd, ["commit", "-m", "add large review file"]);
    yield* git(cwd, ["checkout", "-b", "feature/review-diff-budget"]);
    yield* writeTextFile(cwd, "01-large-review-file.txt", updated);
    yield* writeTextFile(cwd, "02-source-file.ts", sourceAfter);
    yield* git(cwd, ["add", "01-large-review-file.txt", "02-source-file.ts"]);
    yield* git(cwd, ["commit", "-m", "update large review file"]);

    const untrackedLineCount = 12_000;
    const untracked = Array.from(
      { length: untrackedLineCount },
      (_, index) => `untracked-${index}\n`,
    ).join("");
    yield* writeTextFile(cwd, "large-untracked-file.txt", untracked);

    const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef });
    const branchSource = preview.sources.find((source) => source.kind === "branch-range");
    const workingTreeSource = preview.sources.find((source) => source.kind === "working-tree");

    assert.isDefined(branchSource);
    assert.isFalse(branchSource.truncated);
    assert.isAbove(branchSource.diff.length, 120_000);
    assert.include(branchSource.diff, `+after-${lineCount - 1}`);
    assert.include(branchSource.diff, `+${sourceAfter.trimEnd()}`);

    assert.isDefined(workingTreeSource);
    assert.isFalse(workingTreeSource.truncated);
    assert.isAbove(workingTreeSource.diff.length, 80_000);
    assert.include(workingTreeSource.diff, `+untracked-${untrackedLineCount - 1}`);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the combined working-tree review preview to one MiB", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const makeContents = (prefix: string) =>
      Array.from(
        { length: 45_000 },
        (_, index) => `${prefix}-${index.toString().padStart(5, "0")}\n`,
      ).join("");

    yield* writeTextFile(cwd, "01-large-untracked.txt", makeContents("first"));
    yield* writeTextFile(cwd, "02-later-source.ts", makeContents("second"));

    const driver = yield* GitVcsDriver.GitVcsDriver;
    const preview = yield* driver.getReviewDiffPreview({ cwd });
    const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

    assert.isDefined(source);
    assert.isTrue(source.truncated);
    assert.isAtMost(new TextEncoder().encode(source.diff).byteLength, 1024 * 1024);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the fallback working-tree review preview to one MiB", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const pathService = yield* Path.Path;
    const trackedLineCount = 30_000;
    const original = Array.from(
      { length: trackedLineCount },
      (_, index) => `before-${index.toString().padStart(5, "0")}\n`,
    ).join("");
    const updated = Array.from(
      { length: trackedLineCount },
      (_, index) => `after-${index.toString().padStart(5, "0")}\n`,
    ).join("");
    const untracked = Array.from(
      { length: 30_000 },
      (_, index) => `untracked-${index.toString().padStart(5, "0")}\n`,
    ).join("");

    yield* writeTextFile(cwd, "large-tracked.txt", original);
    yield* git(cwd, ["add", "large-tracked.txt"]);
    yield* git(cwd, ["commit", "-m", "add fallback fixture"]);
    yield* writeTextFile(cwd, "large-tracked.txt", updated);
    yield* writeTextFile(cwd, "large-untracked.txt", untracked);

    // Force temporary-index creation to fail so getReviewDiffPreview exercises the
    // tracked + untracked fallback assembly rather than the unified diff path.
    const blockerPath = pathService.join(cwd, "tmp-blocker");
    yield* writeTextFile(cwd, "tmp-blocker", "not a directory\n");
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const preview = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.TMPDIR;
        process.env.TMPDIR = blockerPath;
        return previous;
      }),
      () => driver.getReviewDiffPreview({ cwd }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.TMPDIR;
          } else {
            process.env.TMPDIR = previous;
          }
        }),
    );
    const source = preview.sources.find((candidate) => candidate.kind === "working-tree");

    assert.isDefined(source);
    assert.isTrue(source.truncated);
    assert.include(source.diff, "large-tracked.txt");
    assert.include(source.diff, "large-untracked.txt");
    assert.notInclude(source.diff, "\uFFFD");
    assert.isAtMost(new TextEncoder().encode(source.diff).byteLength, 1024 * 1024);
  }).pipe(Effect.provide(TestLayer)),
);

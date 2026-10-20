import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GitCommandError,
  type ReviewSetStagedInput,
  type ReviewCommitInput,
  type ReviewCommitError,
  type ReviewGenerateCommitMessageInput,
  type ReviewCommitResult,
  type ReviewRevertInput,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly generateCommitMessage: (
      input: ReviewGenerateCommitMessageInput,
    ) => Effect.Effect<string, ReviewCommitError>;
    readonly commit: (
      input: ReviewCommitInput,
    ) => Effect.Effect<ReviewCommitResult, ReviewCommitError>;
    readonly revert: (input: ReviewRevertInput) => Effect.Effect<void, ReviewDiffPreviewError>;
    readonly setStaged: (
      input: ReviewSetStagedInput,
    ) => Effect.Effect<void, ReviewDiffPreviewError>;
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workflow = yield* GitWorkflowService.GitWorkflowService;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation:
      | "ReviewService.getDiffPreview"
      | "ReviewService.getDiffFileContents"
      | "ReviewService.setStaged"
      | "ReviewService.commit"
      | "ReviewService.generateCommitMessage"
      | "ReviewService.revert",
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: "Review operations must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  const setStaged = Effect.fn("ReviewService.setStaged")(function* (input: ReviewSetStagedInput) {
    yield* assertWorkspaceBoundCwd("ReviewService.setStaged", input.cwd);
    if (
      (input.paths.length === 0 && input.patch === undefined) ||
      input.paths.some((file) => path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
    ) {
      return yield* new GitCommandError({
        operation: "ReviewService.setStaged",
        cwd: input.cwd,
        command: "git",
        detail: "Choose repository-relative files or a diff hunk to stage.",
      });
    }
    if (input.patch !== undefined) {
      yield* git.execute({
        operation: "ReviewService.setStaged.patch",
        cwd: input.cwd,
        args: [
          "apply",
          "--cached",
          "--unidiff-zero",
          ...(input.staged ? [] : ["--reverse"]),
          "--",
          "-",
        ],
        stdin: input.patch,
      });
      yield* workflow.invalidateLocalStatus(input.cwd);
      return;
    }
    const paths = input.paths.map((file) => `:(literal)${file}`);
    if (input.staged) {
      yield* git.execute({
        operation: "ReviewService.setStaged.files",
        cwd: input.cwd,
        args: ["add", "--all", "--", ...paths],
      });
    } else {
      const head = yield* git.execute({
        operation: "ReviewService.setStaged.head",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      });
      yield* git.execute({
        operation: "ReviewService.setStaged.files",
        cwd: input.cwd,
        args:
          head.exitCode === 0
            ? ["restore", "--staged", "--", ...paths]
            : ["rm", "--cached", "--force", "--", ...paths],
      });
    }
    yield* workflow.invalidateLocalStatus(input.cwd);
  });
  const generateCommitMessage = Effect.fn("ReviewService.generateCommitMessage")(function* (
    input: ReviewGenerateCommitMessageInput,
  ) {
    yield* assertWorkspaceBoundCwd("ReviewService.generateCommitMessage", input.cwd);
    return yield* workflow.generateStagedCommitMessage(input);
  });
  const commit = Effect.fn("ReviewService.commit")(function* (input: ReviewCommitInput) {
    yield* assertWorkspaceBoundCwd("ReviewService.commit", input.cwd);
    const message =
      input.message.trim() || (yield* workflow.generateStagedCommitMessage({ cwd: input.cwd }));
    const [subject = "", ...body] = message.split("\n");
    // No stage option: commit exactly the current index, preserving partial staging.
    const { commitSha } = yield* git.commit(input.cwd, subject, body.join("\n"), {
      amend: input.action === "amend",
      timeoutMs: 10 * 60_000,
    });
    const pushStatus =
      input.action === "commit-push"
        ? yield* git
            .pushCurrentBranch(input.cwd, null)
            .pipe(
              Effect.as("pushed" as const),
              Effect.catchTags({ GitCommandError: () => Effect.succeed("failed" as const) }),
            )
        : ("not-requested" as const);
    yield* workflow.invalidateStatus(input.cwd);
    return { commitSha, pushStatus };
  });

  const revert = Effect.fn("ReviewService.revert")(function* (input: ReviewRevertInput) {
    yield* assertWorkspaceBoundCwd("ReviewService.revert", input.cwd);
    if (
      (input.paths.length === 0 && input.patch === undefined) ||
      input.paths.some(
        (file) => path.isAbsolute(file) || file === "." || file.split(/[\\/]/).includes(".."),
      )
    ) {
      return yield* new GitCommandError({
        operation: "ReviewService.revert",
        cwd: input.cwd,
        command: "git restore",
        detail: "Choose repository-relative changed files to revert.",
      });
    }
    if (input.patch !== undefined) {
      yield* git.execute({
        operation: "ReviewService.revert.patch",
        cwd: input.cwd,
        args: ["apply", "--reverse", "--unidiff-zero", "--", "-"],
        stdin: input.patch,
      });
      yield* workflow.invalidateLocalStatus(input.cwd);
      return;
    }
    const paths = [...new Set(input.paths)].map((file) => `:(literal)${file}`);
    const tracked = yield* git.execute({
      operation: "ReviewService.revert.tracked",
      cwd: input.cwd,
      args: ["ls-files", "--cached", "-z", "--", ...paths],
    });
    const trackedPaths = tracked.stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => `:(literal)${file}`);
    if (trackedPaths.length > 0)
      yield* git.execute({
        operation: "ReviewService.revert.restore",
        cwd: input.cwd,
        args: ["restore", "--worktree", "--", ...trackedPaths],
      });
    // Clean only the explicit selection. Indexed files (including staged additions) are kept.
    yield* git.execute({
      operation: "ReviewService.revert.untracked",
      cwd: input.cwd,
      args: ["clean", "-f", "--", ...paths],
    });
    yield* workflow.invalidateLocalStatus(input.cwd);
  });
  return ReviewService.of({
    generateCommitMessage,
    commit,
    revert,
    setStaged,
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);

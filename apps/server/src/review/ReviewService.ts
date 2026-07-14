import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  SourceControlProviderError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type PullRequestReviewError,
  type PullRequestReviewInput,
  type PullRequestReviewResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getPullRequest: (
      input: PullRequestReviewInput,
    ) => Effect.Effect<PullRequestReviewResult, PullRequestReviewError>;
  }
>()("t3/review/ReviewService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

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

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    cwd: string,
    operation = "ReviewService.getDiffPreview",
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail: "Review cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd);

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

  const getPullRequest: ReviewService["Service"]["getPullRequest"] = Effect.fn(
    "ReviewService.getPullRequest",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd(input.cwd, "ReviewService.getPullRequest");
    const handle = yield* sourceControlProviders.resolveHandle({ cwd: input.cwd });
    const getChangeRequestReview = handle.provider.getChangeRequestReview;
    if (!getChangeRequestReview) {
      return yield* new SourceControlProviderError({
        provider: handle.provider.kind,
        operation: "getChangeRequestReview",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `Pull request comments are not supported for ${handle.provider.kind}.`,
      });
    }
    return yield* getChangeRequestReview({
      cwd: input.cwd,
      ...(handle.context ? { context: handle.context } : {}),
      reference: input.reference,
    });
  });

  return ReviewService.of({
    getDiffPreview,
    getPullRequest,
  });
});

export const layer = Layer.effect(ReviewService, make);

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { ReviewWatcher, type ReviewWatchTarget } from "./ReviewWatcher.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly streamDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Stream.Stream<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

const hasSameDiffPreview = (
  left: ReviewDiffPreviewResult,
  right: ReviewDiffPreviewResult,
): boolean =>
  left.cwd === right.cwd &&
  left.sources.length === right.sources.length &&
  left.sources.every((source, index) => {
    const other = right.sources[index];
    return (
      other !== undefined &&
      source.id === other.id &&
      source.kind === other.kind &&
      source.title === other.title &&
      source.baseRef === other.baseRef &&
      source.headRef === other.headRef &&
      source.diffHash === other.diffHash &&
      source.truncated === other.truncated
    );
  });

type DiffPreviewWatchSource = "workspace" | "metadata" | "ready";

interface DiffPreviewWatchTarget {
  readonly path: string;
  readonly source: DiffPreviewWatchSource;
  readonly ignoredPaths: ReadonlyArray<string>;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const reviewWatcher = yield* ReviewWatcher;

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
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    const registeredProject = yield* projectionSnapshotQuery
      .getActiveProjectByWorkspaceRoot(path.resolve(cwd))
      .pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation: "ReviewService.assertWorkspaceBoundCwd.resolveProject",
              cwd,
              detail: "Failed to resolve the registered review workspace.",
              cause,
            }),
        ),
      );
    if (Option.isSome(registeredProject)) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation: "ReviewService.getDiffPreview",
      cwd,
      detail: "Review diff preview cwd must stay within a configured or registered workspace root.",
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

  const resolveDiffPreviewWatchPaths = Effect.fn("ReviewService.resolveDiffPreviewWatchPaths")(
    function* (input: ReviewDiffPreviewInput) {
      yield* assertWorkspaceBoundCwd(input.cwd);
      const workspaceRoot = yield* canonicalizePath(input.cwd);
      const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
      if (!handle) {
        return {
          workspaceRoot,
          handle,
          watchTargets: [
            { path: workspaceRoot, source: "workspace", ignoredPaths: [] },
          ] satisfies DiffPreviewWatchTarget[],
        };
      }

      const metadataPaths = new Set<string>();
      if (handle.repository.metadataPath) {
        metadataPaths.add(handle.repository.metadataPath);
      }
      if (handle.kind === "git") {
        const gitDir = yield* handle.driver
          .execute({
            operation: "ReviewService.resolveDiffPreviewWatchPaths.gitDir",
            cwd: input.cwd,
            args: ["rev-parse", "--absolute-git-dir"],
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() || null),
            Effect.orElseSucceed(() => null),
          );
        if (gitDir) {
          metadataPaths.add(gitDir);
        }
      }

      const canonicalMetadataPaths: string[] = [];
      for (const metadataPath of metadataPaths) {
        const canonicalMetadataPath = yield* canonicalizePath(
          path.isAbsolute(metadataPath) ? metadataPath : path.resolve(input.cwd, metadataPath),
        );
        if (!canonicalMetadataPaths.includes(canonicalMetadataPath)) {
          canonicalMetadataPaths.push(canonicalMetadataPath);
        }
      }

      const ignoredWorkspacePaths =
        input.sourceKind === "branch-range" || handle.kind !== "git"
          ? []
          : yield* handle.driver
              .execute({
                operation: "ReviewService.resolveDiffPreviewWatchPaths.ignoredDirectories",
                cwd: input.cwd,
                args: ["ls-files", "--others", "--ignored", "--directory", "--exclude-standard"],
              })
              .pipe(
                Effect.map((result) =>
                  result.stdout
                    .split("\n")
                    .filter((entry) => entry.endsWith("/"))
                    .map((entry) => path.resolve(workspaceRoot, entry)),
                ),
                Effect.orElseSucceed(() => []),
              );
      const targets: DiffPreviewWatchTarget[] =
        input.sourceKind === "branch-range"
          ? []
          : [
              {
                path: workspaceRoot,
                source: "workspace",
                ignoredPaths: [...ignoredWorkspacePaths, ...canonicalMetadataPaths],
              },
            ];
      for (const metadataPath of canonicalMetadataPaths) {
        targets.push({
          path: metadataPath,
          source: "metadata",
          ignoredPaths: [path.join(metadataPath, "logs"), path.join(metadataPath, "objects")],
        });
      }
      return { workspaceRoot, handle, watchTargets: targets };
    },
  );

  const shouldRefreshForChanges = Effect.fn("ReviewService.shouldRefreshForChanges")(function* (
    input: ReviewDiffPreviewInput,
    workspaceRoot: string,
    handle: VcsDriverRegistry.VcsDriverHandle | null,
    changes: ReadonlyArray<{
      readonly source: DiffPreviewWatchSource;
      readonly path: string;
    }>,
  ) {
    if (changes.some((change) => change.source !== "workspace") || !handle) {
      return true;
    }

    const relativePaths = [
      ...new Set(
        changes.map((change) =>
          path.isAbsolute(change.path) ? path.relative(workspaceRoot, change.path) : change.path,
        ),
      ),
    ].filter((relativePath) => relativePath.length > 0 && relativePath !== ".");
    if (relativePaths.length === 0) {
      return true;
    }

    return yield* handle.driver.filterIgnoredPaths(input.cwd, relativePaths).pipe(
      Effect.map((includedPaths) => includedPaths.length > 0),
      Effect.orElseSucceed(() => true),
    );
  });

  const makeWatchedDiffPreviewStream = (input: ReviewDiffPreviewInput) =>
    Stream.unwrap(
      resolveDiffPreviewWatchPaths(input).pipe(
        Effect.map(({ handle, workspaceRoot, watchTargets }) => {
          const watcherTargets: ReviewWatchTarget[] = watchTargets.map(
            ({ path: targetPath, ignoredPaths }) => ({ path: targetPath, ignoredPaths }),
          );
          const fileChanges = reviewWatcher.watch(watcherTargets).pipe(
            Stream.map((event) => {
              if (event._tag === "Ready") {
                return { source: "ready" as const, path: workspaceRoot };
              }
              const metadataTarget = watchTargets.find(
                (target) => target.source === "metadata" && isWithinRoot(event.path, target.path),
              );
              return {
                source: metadataTarget?.source ?? "workspace",
                path: event.path,
              };
            }),
            Stream.mapError(
              (cause) =>
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.streamDiffPreview.watch",
                  cwd: input.cwd,
                  detail: "Failed to watch the review workspace for changes.",
                  cause,
                }),
            ),
            Stream.groupedWithin(10_000, Duration.millis(150)),
            Stream.filterEffect((changes) =>
              shouldRefreshForChanges(input, workspaceRoot, handle, Array.from(changes)),
            ),
            Stream.map(() => undefined),
          );

          return fileChanges.pipe(
            Stream.mapEffect(() => getDiffPreview(input), { concurrency: 1 }),
          );
        }),
      ),
    );

  const streamDiffPreview: ReviewService["Service"]["streamDiffPreview"] = (input) =>
    Stream.fromEffect(getDiffPreview(input)).pipe(
      Stream.concat(makeWatchedDiffPreviewStream(input)),
      Stream.changesWith(hasSameDiffPreview),
    );

  return ReviewService.of({
    getDiffPreview,
    streamDiffPreview,
  });
});

export const layer = Layer.effect(ReviewService, make);

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { expandHomePathWith } from "../pathExpansion.ts";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
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
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const projectRepository = yield* Effect.serviceOption(ProjectionProjectRepository);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;

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
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const settings = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new VcsRepositoryDetectionError({
                operation,
                cwd,
                detail: "Failed to read worktree locations.",
                cause,
              }),
          ),
        )
      : null;
    const configuredRoots =
      settings === null
        ? []
        : [
            settings.worktreeBaseDirectory,
            ...Object.values(settings.projectSettingsOverrides).map(
              (entry) => entry.worktreeBaseDirectory ?? "",
            ),
          ].filter((root) => root !== "");
    const [candidate, ...roots] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
      ...configuredRoots.map((root) => canonicalizePath(expandHomePathWith(root, path))),
    ]);

    if (roots.some((root) => isWithinRoot(candidate, root))) {
      return;
    }

    // Changing the default must not revoke access to previously created worktrees.
    // Git's registrations remain authoritative after the setting is reset.
    if (Option.isSome(projectRepository)) {
      const projects = yield* projectRepository.value.listAll().pipe(
        Effect.mapError(
          (cause) =>
            new VcsRepositoryDetectionError({
              operation,
              cwd,
              detail: "Failed to read project worktree registrations.",
              cause,
            }),
        ),
      );
      const repositoryRoots = new Set([
        config.cwd,
        ...projects
          .filter((project) => project.deletedAt === null)
          .map((project) => project.workspaceRoot),
      ]);
      for (const repositoryRoot of repositoryRoots) {
        const info = yield* fileSystem.stat(repositoryRoot).pipe(
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(null)
                : Effect.fail(
                    new VcsRepositoryDetectionError({
                      operation,
                      cwd: repositoryRoot,
                      detail: "Failed to inspect a project worktree root.",
                      cause,
                    }),
                  ),
          }),
        );
        if (info === null || info.type !== "Directory") continue;
        const registered = yield* git.execute({
          operation,
          cwd: repositoryRoot,
          args: ["worktree", "list", "--porcelain", "-z"],
          allowNonZeroExit: true,
        });
        for (const field of registered.stdout.split("\0")) {
          if (!field.startsWith("worktree ")) continue;
          const root = yield* canonicalizePath(field.slice("worktree ".length));
          if (isWithinRoot(candidate, root)) return;
        }
      }
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
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

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);

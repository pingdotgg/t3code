import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  TextGenerationError,
  ModelSelection,
  ReviewCommitDescriptionsInput,
  type GitCommandError,
  type ReviewCommitDescriptionsResult,
  type ReviewCommitDescriptionsError,
  type ReviewBranchCommitsInput,
  type ReviewBranchCommitsResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const isCommitDescriptionsInput = Schema.is(ReviewCommitDescriptionsInput);
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getBranchCommits: (
      input: ReviewBranchCommitsInput,
    ) => Effect.Effect<ReviewBranchCommitsResult, ReviewDiffPreviewError>;
    readonly generateCommitDescriptions: (
      input: ReviewCommitDescriptionsInput,
    ) => Effect.Effect<ReviewCommitDescriptionsResult, ReviewCommitDescriptionsError>;
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
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const cachedDescriptions = new Map<string, string>();
  const pendingDescriptions = new Map<
    string,
    Deferred.Deferred<string, TextGenerationError | GitCommandError>
  >();

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
      | "ReviewService.getBranchCommits"
      | "ReviewService.generateCommitDescriptions"
      | "ReviewService.getDiffPreview"
      | "ReviewService.getDiffFileContents",
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
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : operation === "ReviewService.getBranchCommits"
            ? "Review commit list cwd must stay within the configured workspace root."
            : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getBranchCommits: ReviewService["Service"]["getBranchCommits"] = Effect.fn(
    "ReviewService.getBranchCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getBranchCommits", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) return { commits: [], truncated: false };
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getBranchCommits",
        kind: handle.kind,
        detail: "Review commit lists require a Git repository.",
      });
    }
    return yield* git.getReviewBranchCommits(input);
  });

  const generateCommitDescriptions: ReviewService["Service"]["generateCommitDescriptions"] =
    Effect.fn("ReviewService.generateCommitDescriptions")(function* (input) {
      if (!isCommitDescriptionsInput(input)) {
        return yield* new TextGenerationError({
          operation: "generateCommitDescriptions",
          detail: "Request between 1 and 10 full commit hashes.",
        });
      }
      yield* assertWorkspaceBoundCwd("ReviewService.generateCommitDescriptions", input.cwd);
      const invalidThread = () =>
        new VcsRepositoryDetectionError({
          operation: "ReviewService.generateCommitDescriptions",
          cwd: input.cwd,
          detail: "The review thread does not own this workspace.",
        });
      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitDescriptions",
              detail: "Could not read the review thread.",
              cause,
            }),
        ),
      );
      if (!thread) return yield* invalidThread();
      const project = yield* projects.getShell(thread.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitDescriptions",
              detail: "Could not read the review project.",
              cause,
            }),
        ),
      );
      if (!project) return yield* invalidThread();
      const [candidate, expected] = yield* Effect.all([
        canonicalizePath(input.cwd),
        canonicalizePath(thread.worktreePath ?? project.workspaceRoot),
      ]);
      if (candidate !== expected) return yield* invalidThread();

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitDescriptions",
              detail: "Could not read text generation settings.",
              cause,
            }),
        ),
      );
      const modelSelection = resolveProjectSettings(settings, thread.projectId).settings
        .textGenerationModelSelection;
      const modelKey = encodeModelSelection(modelSelection);
      const resolved = yield* git.resolveReviewCommits({
        cwd: input.cwd,
        shas: [...new Set(input.shas)],
      });
      const descriptions = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const requested = yield* Effect.forEach(resolved.commits, (commit) =>
            Effect.gen(function* () {
              const key = `${resolved.repositoryKey}\0${commit.sha}\0${modelKey}`;
              const fresh = yield* Deferred.make<string, TextGenerationError | GitCommandError>();
              return yield* Effect.sync(() => {
                const cached = cachedDescriptions.get(key);
                if (cached !== undefined) {
                  cachedDescriptions.delete(key);
                  cachedDescriptions.set(key, cached);
                  return { kind: "cached" as const, commit, key, description: cached };
                }
                const pending = pendingDescriptions.get(key);
                if (pending) return { kind: "pending" as const, commit, key, pending };
                pendingDescriptions.set(key, fresh);
                return { kind: "claimed" as const, commit, key, pending: fresh };
              });
            }),
          );
          const claimed = requested.filter((item) => item.kind === "claimed");
          if (claimed.length > 0) {
            const generated = yield* restore(
              git
                .getReviewCommitDescriptionContext({
                  cwd: input.cwd,
                  shas: claimed.map((item) => item.commit.sha),
                })
                .pipe(
                  Effect.flatMap((context) =>
                    textGeneration.generateCommitDescriptions({
                      cwd: input.cwd,
                      commits: context.commits,
                      modelSelection,
                    }),
                  ),
                  Effect.flatMap((result) => {
                    const descriptions = new Map(
                      result.descriptions.map((item) => [item.sha, item.description]),
                    );
                    return descriptions.size === claimed.length &&
                      claimed.every((item) => descriptions.get(item.commit.sha)?.trim()) &&
                      result.descriptions.length === claimed.length
                      ? Effect.succeed(descriptions)
                      : Effect.fail(
                          new TextGenerationError({
                            operation: "generateCommitDescriptions",
                            detail: "The model returned incomplete commit descriptions.",
                          }),
                        );
                  }),
                ),
            ).pipe(Effect.exit);
            for (const item of claimed) {
              pendingDescriptions.delete(item.key);
              if (Exit.isSuccess(generated)) {
                const description = generated.value
                  .get(item.commit.sha)!
                  .trim()
                  .replace(/\s+/g, " ")
                  .slice(0, 80);
                cachedDescriptions.set(item.key, description);
                if (cachedDescriptions.size > 512) {
                  cachedDescriptions.delete(cachedDescriptions.keys().next().value!);
                }
                yield* Deferred.succeed(item.pending, description);
              } else {
                yield* Deferred.failCause(item.pending, generated.cause);
              }
            }
          }
          return yield* restore(
            Effect.forEach(requested, (item) =>
              item.kind === "cached"
                ? Effect.succeed({ sha: item.commit.sha, description: item.description })
                : Deferred.await(item.pending).pipe(
                    Effect.map((description) => ({ sha: item.commit.sha, description })),
                  ),
            ),
          );
        }),
      );
      return { modelSelection, descriptions };
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
    getBranchCommits,
    generateCommitDescriptions,
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);

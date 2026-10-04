import { OrchestratorMcpFailure, type ReviewDiffPreviewInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Project from "../../../project/ProjectService.ts";
import * as Review from "../../../review/ReviewService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { ReviewToolkit } from "./tools.ts";

const DEFAULT_DIFF_CHARACTERS = 20_000;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const ReviewToolkitHandlersLive = ReviewToolkit.toLayer({
  t3_thread_diff: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) return yield* invalid("The project was not found.");
      const review = yield* Review.ReviewService;
      // A file request reads a single source; branch-range covers committed and uncommitted work.
      const sourceKind = input.source ?? (input.file === undefined ? undefined : "branch-range");
      const readPreview = (file?: ReviewDiffPreviewInput["file"]) =>
        review
          .getDiffPreview({
            cwd: thread.worktreePath ?? project.value.workspaceRoot,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            ...(file === undefined ? {} : { file }),
          })
          .pipe(
            Effect.mapError((error) => {
              switch (error._tag) {
                case "VcsRepositoryDetectionError":
                case "VcsUnsupportedOperationError":
                  return invalid(error.detail);
                // A baseRef with no common commit with HEAD is the caller's mistake.
                case "GitCommandError":
                  return error.operation === "GitVcsDriver.resolveReviewMergeBase"
                    ? invalid(error.detail)
                    : unavailable();
                default:
                  return unavailable();
              }
            }),
          );
      let preview;
      if (input.file !== undefined && sourceKind !== undefined) {
        // A renamed file needs its old path, which only the full preview's stats know. The lookup
        // is best effort: a working-tree read must not fail on a branch range it does not need.
        const full = yield* readPreview().pipe(Effect.orElseSucceed(() => undefined));
        const previousPath =
          full?.sources
            .find((source) => source.kind === sourceKind)
            ?.files?.find((file) => file.path === input.file)?.previousPath ?? null;
        preview = yield* readPreview({ path: input.file, previousPath, sourceKind });
      } else {
        preview = yield* readPreview();
      }
      if (preview.sources.length === 0)
        return yield* invalid("The thread's checkout is not a git repository.");
      const maxCharacters = input.maxCharacters ?? DEFAULT_DIFF_CHARACTERS;
      return {
        threadId: thread.id,
        cwd: preview.cwd,
        sources: preview.sources
          .filter((source) => sourceKind === undefined || source.kind === sourceKind)
          .map((source) => ({
            kind: source.kind,
            title: source.title,
            baseRef: source.baseRef,
            headRef: source.headRef,
            files: source.files ?? null,
            diff: source.diff.slice(0, maxCharacters),
            truncated: source.truncated || source.diff.length > maxCharacters,
          })),
      };
    }),
});

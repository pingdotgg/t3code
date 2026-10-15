import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as Review from "../../../review/ReviewService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const handlers = {
  t3_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext.McpInvocationContext;
      if (!context.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot inspect worktrees.",
        });
      const { threadId, ...refs } = input;
      const {
        projection: { thread },
      } = yield* readThread(threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const git = yield* GitWorkflow.GitWorkflowService;
      return yield* git
        .listRefs({ ...refs, cwd: thread.worktreePath ?? project.value.workspaceRoot })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_thread_diff: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const review = yield* Review.ReviewService;
      const preview = yield* review
        .getDiffPreview(
          {
            cwd: thread.worktreePath ?? project.value.workspaceRoot,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
          },
          project.value.workspaceRoot,
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "VcsRepositoryDetectionError" ||
            error._tag === "VcsUnsupportedOperationError"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail })
              : unavailable(),
          ),
        );
      if (preview.sources.length === 0)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The thread's checkout is not a repository.",
        });
      const maxCharacters = input.maxCharacters ?? 20_000;
      return {
        threadId: thread.id,
        cwd: preview.cwd,
        sources: preview.sources
          .filter((source) => input.source === undefined || source.kind === input.source)
          .map((source) => ({
            kind: source.kind,
            baseRef: source.baseRef,
            headRef: source.headRef,
            files: source.files ?? null,
            diff: source.diff.slice(0, maxCharacters),
            truncated: source.truncated || source.diff.length > maxCharacters,
          })),
      };
    }),
  ),
  t3_worktree_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.handoff(scope, input);
    }),
  ),
  t3_worktree_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.status(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorktreeToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorktreeToolkit, handlers);

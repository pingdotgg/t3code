import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import {
  assertFullAccess,
  loadCaller,
  readThread,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeService from "../../../vcs/WorktreeService.ts";
import { WorktreeToolkit } from "./tools.ts";

const requireWorktreeCapability = Effect.gen(function* () {
  const context = yield* McpInvocationContext.McpInvocationContext;
  if (!context.capabilities.has("worktree"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot inspect worktrees.",
    });
});

const handlers = {
  t3_worktree_inventory: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* requireWorktreeCapability;
      const projectId = yield* resolveProjectId(yield* loadCaller(), undefined);
      const worktrees = yield* WorktreeService.WorktreeService;
      return yield* worktrees.listWorktrees({ projectId }).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_worktree_remove: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireWorktreeCapability;
      const context = yield* loadCaller();
      yield* assertFullAccess(
        context,
        "Removing worktrees requires a full-access/default calling thread.",
      );
      const projectId = yield* resolveProjectId(context, undefined);
      const worktrees = yield* WorktreeService.WorktreeService;
      // Scoped to the caller's project; ignored files stay unless the agent opts in.
      return yield* worktrees
        .pruneWorktrees({ ...input, projectId })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireWorktreeCapability;
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

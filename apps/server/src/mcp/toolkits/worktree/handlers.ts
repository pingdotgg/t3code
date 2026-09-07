import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { WorktreeMcpService } from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const handlers = {
  t3_worktree_list: (input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext;
      if (!context.capabilities.has("worktree"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This credential cannot inspect worktrees.",
        });
      const { caller } = yield* readCaller();
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const git = yield* GitWorkflow.GitWorkflowService;
      return yield* git
        .listRefs({ ...input, cwd: caller.worktreePath ?? project.value.workspaceRoot })
        .pipe(Effect.mapError(unavailable));
    }),
  t3_worktree_handoff: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* WorktreeMcpService;
      return yield* service.handoff(scope, input);
    }),
  t3_worktree_status: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* WorktreeMcpService;
      return yield* service.status(scope);
    }),
} satisfies Parameters<typeof WorktreeToolkit.toLayer>[0];

export const WorktreeToolkitHandlersLive = WorktreeToolkit.toLayer(handlers);

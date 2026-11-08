import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { ManagedSandboxToolkit } from "./tools.ts";

const handlers = {
  t3_worktree_prepare_sandbox: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        return yield* service.prepareSandbox(scope, input.projectId, input.branch);
      }),
    { linkedCallers: "allowed" },
  ),
  t3_worktree_run_sandbox_setup: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeMcpService.WorktreeMcpService;
        return yield* service.runSandboxSetup(scope, input.projectId, input.threadId);
      }),
    { linkedCallers: "allowed" },
  ),
  preview_share: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.sharePreview(scope, input.port);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ManagedSandboxToolkit.tools>;

export const layer = McpToolAccess.toLayer(ManagedSandboxToolkit, handlers);

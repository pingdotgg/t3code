import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { WorktreeMcpService } from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const handlers = {
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

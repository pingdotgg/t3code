import * as Effect from "effect/Effect";

import { CheckpointMcpService } from "../../CheckpointMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { CheckpointToolkit } from "./tools.ts";

const handlers = {
  t3_checkpoint_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* CheckpointMcpService;
      return yield* service.list(scope, input);
    }),
  t3_checkpoint_diff: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* CheckpointMcpService;
      return yield* service.diff(scope, input);
    }),
  t3_checkpoint_restore: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* CheckpointMcpService;
      return yield* service.restore(scope, input);
    }),
} satisfies Parameters<typeof CheckpointToolkit.toLayer>[0];

export const CheckpointToolkitHandlersLive = CheckpointToolkit.toLayer(handlers);

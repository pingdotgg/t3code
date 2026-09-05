import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { QueueMcpService } from "../../QueueMcpService.ts";
import { QueueToolkit } from "./tools.ts";

const handlers = {
  t3_queue_list: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).list(yield* McpInvocationContext, input);
    }),
  t3_queue_read: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).read(yield* McpInvocationContext, input);
    }),
  t3_queue_edit: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).edit(yield* McpInvocationContext, input);
    }),
  t3_queue_reorder: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).reorder(yield* McpInvocationContext, input);
    }),
  t3_queue_cancel: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).cancel(yield* McpInvocationContext, input);
    }),
  t3_queue_promote_to_steer: (input) =>
    Effect.gen(function* () {
      return yield* (yield* QueueMcpService).promote(yield* McpInvocationContext, input);
    }),
} satisfies Parameters<typeof QueueToolkit.toLayer>[0];

export const QueueToolkitHandlersLive = QueueToolkit.toLayer(handlers);

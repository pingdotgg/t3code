import { CommandId, ThreadAttentionToolError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadAttentionToolkit } from "./tools.ts";

const dispatchFailure = () =>
  new ThreadAttentionToolError({
    message: "Could not update this thread's attention status.",
  });

export const threadAttentionHandlers = {
  set_thread_attention: ({ kind }) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const attention = { kind, raisedAt: createdAt } as const;
      yield* engine
        .dispatch({
          type: "thread.attention.set",
          commandId: CommandId.make(
            `mcp:thread-attention:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.threadId,
          attention,
          createdAt,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { attention };
    }),
  clear_thread_attention: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine
        .dispatch({
          type: "thread.attention.clear",
          commandId: CommandId.make(
            `mcp:thread-attention:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.threadId,
          createdAt,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { attention: null };
    }),
} satisfies Parameters<typeof ThreadAttentionToolkit.toLayer>[0];

export const ThreadAttentionToolkitHandlersLive =
  ThreadAttentionToolkit.toLayer(threadAttentionHandlers);

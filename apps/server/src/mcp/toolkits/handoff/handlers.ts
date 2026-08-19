import { CommandId, ThreadHandoffId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ThreadHandoffToolkit } from "./tools.ts";
import type { RequestThreadHandoffInput } from "./tools.ts";

export const requestThreadHandoff = Effect.fn("ThreadHandoffToolkit.requestThreadHandoff")(
  function* (input: typeof RequestThreadHandoffInput.Type) {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const handoffId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.handoff.request",
      commandId: CommandId.make(requestId),
      threadId: invocation.threadId,
      handoffId: ThreadHandoffId.make(handoffId),
      title: input.title,
      prompt: input.prompt,
      artifactReferences: input.artifactReferences,
      createdAt,
    });
    return { handoffId: ThreadHandoffId.make(handoffId) };
  },
);

export const ThreadHandoffToolkitHandlersLive = ThreadHandoffToolkit.toLayer({
  request_thread_handoff: (input) =>
    requestThreadHandoff(input).pipe(
      Effect.mapError((error) => ({
        message: error instanceof Error ? error.message : "Unable to request a thread handoff.",
      })),
    ),
});

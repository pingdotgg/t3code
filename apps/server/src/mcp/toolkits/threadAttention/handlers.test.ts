import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { threadAttentionHandlers } from "./handlers.ts";

it.effect("dispatches attention commands only to the authenticated thread", () => {
  const commands: Array<OrchestrationCommand> = [];
  const boundThreadId = ThreadId.make("bound-thread");
  const engine = OrchestrationEngineService.of({
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
  });
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: boundThreadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 0,
  };

  const testLayer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(OrchestrationEngineService, engine),
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
  );

  return Effect.gen(function* () {
    const marked = yield* threadAttentionHandlers.set_thread_attention({
      kind: "question",
    });
    const cleared = yield* threadAttentionHandlers.clear_thread_attention();

    expect(marked.attention.kind).toBe("question");
    expect(cleared.attention).toBeNull();
    expect(commands.map((command) => command.type)).toEqual([
      "thread.attention.set",
      "thread.attention.clear",
    ]);
    expect(
      commands.every((command) => "threadId" in command && command.threadId === boundThreadId),
    ).toBe(true);
  }).pipe(Effect.provide(testLayer));
});

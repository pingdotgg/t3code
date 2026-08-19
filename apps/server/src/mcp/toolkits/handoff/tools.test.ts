import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { requestThreadHandoff } from "./handlers.ts";
import { RequestThreadHandoffTool } from "./tools.ts";

it("exposes the agent handoff request without target-thread input", () => {
  const schema = Tool.getJsonSchema(RequestThreadHandoffTool) as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };

  expect(RequestThreadHandoffTool.name).toBe("request_thread_handoff");
  expect(schema.properties?.title).toBeDefined();
  expect(schema.properties?.prompt).toBeDefined();
  expect(schema.properties?.artifactReferences).toBeDefined();
  expect(schema.properties?.threadId).toBeUndefined();
});

it.layer(NodeServices.layer)("binds a handoff request to its authenticated source thread", (it) => {
  it.effect("does not accept a target thread from the provider", () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const result = yield* requestThreadHandoff({
        title: "Implementation",
        prompt: "Implement docs/spec.md",
        artifactReferences: ["docs/spec.md"],
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("source-thread"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<"preview">(),
          issuedAt: 0,
        }),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: 1 });
          },
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      );

      expect(result.handoffId).toBeDefined();
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.handoff.request",
        threadId: ThreadId.make("source-thread"),
        title: "Implementation",
        prompt: "Implement docs/spec.md",
      });
    }),
  );
});

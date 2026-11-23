import { expect, it } from "@effect/vitest";
import { EnvironmentId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AgentctlSandboxes from "../../../agentctl/AgentctlSandboxes.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SandboxHandlers from "./handlers.ts";
import { SandboxToolkit } from "./tools.ts";

const harness = (access: RuntimeMode, removed: Array<string>) =>
  McpToolAccess.HandlersLayer.layer(SandboxHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "client:session-1",
          thread: undefined,
          client: { sessionId: "session-1", label: "Claude Code", access },
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(AgentctlSandboxes.AgentctlSandboxes)({
          remove: (name) =>
            Effect.sync(() => void removed.push(name)).pipe(Effect.as({ error: null })),
        }),
      ),
    ),
  );

const runDelete = (access: RuntimeMode) => {
  const removed: Array<string> = [];
  return Effect.gen(function* () {
    const toolkit = yield* SandboxToolkit;
    const result = yield* toolkit
      .handle("t3_sandbox_delete", { name: "worker-1" })
      .pipe(Stream.unwrap, Stream.runCollect);
    return { result: result.at(-1)?.result, removed };
  }).pipe(Effect.provide(harness(access, removed)));
};

it.effect("deletes a Sandbox for a full-access client", () =>
  Effect.gen(function* () {
    const { removed } = yield* runDelete("full-access");
    expect(removed).toEqual(["worker-1"]);
  }),
);

it.effect("refuses to delete a Sandbox for a client that needs approval", () =>
  Effect.gen(function* () {
    const { result, removed } = yield* runDelete("approval-required");
    expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure" });
    expect(removed).toEqual([]);
  }),
);

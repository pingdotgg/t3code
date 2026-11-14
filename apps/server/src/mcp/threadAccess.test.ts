import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertTargetWithinLimits, readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("identifies the target and effective caller ceiling when a thread write is refused", () =>
  Effect.gen(function* () {
    for (const [runtimeMode, interactionMode, code] of [
      ["approval-required", "default", "runtime_mode_escalation_denied"],
      ["full-access", "plan", "interaction_mode_escalation_denied"],
      ["approval-required", "plan", "runtime_mode_escalation_denied"],
    ] as const) {
      const target = liveThreadShell(bareId, { runtimeMode: "full-access" });
      const error = yield* assertTargetWithinLimits({ runtimeMode, interactionMode }, target).pipe(
        Effect.flip,
      );

      expect(error.code).toBe(code);
      expect(error.message).toContain(bareId);
      expect(error.message).toContain("full-access/default");
      expect(error.message).toContain(`${runtimeMode}/${interactionMode}`);
      expect(error.message).not.toMatch(/child|parent mode/i);
    }
  }),
);

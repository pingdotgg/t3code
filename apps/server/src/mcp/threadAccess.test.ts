import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { type CallerLimits, assertTargetWithinLimits, readThread } from "./threadAccess.ts";

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

// A thread write is refused for a ceiling, not for delegation. The refusal must
// name the thread and the ways out: the delegated-task wording named a "parent"
// that does not exist here, so agents retried the same send unchanged.
const supervisedCaller: CallerLimits = {
  runtimeMode: "approval-required",
  interactionMode: "default",
};

const refusalFor = (target: { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode }) =>
  assertTargetWithinLimits(supervisedCaller, {
    id: ThreadId.make("thread:target"),
    ...target,
  }).pipe(Effect.flip);

it.effect("names the thread, both modes, and the ways out when a target runs above the caller", () =>
  Effect.gen(function* () {
    const error = yield* refusalFor({ runtimeMode: "full-access", interactionMode: "default" });

    expect(error.code).toBe("runtime_mode_escalation_denied");
    expect(error.message).toContain("Thread thread:target runs in full-access/default");
    expect(error.message).toContain("(approval-required/default)");
    expect(error.message).toContain("delegate_task");
    // The delegated-task wording told the reader to look for a parent.
    expect(error.message).not.toContain("Child");
    expect(error.message).not.toContain("parent mode");
  }),
);

it.effect("reports an interaction ceiling under its own code", () =>
  assertTargetWithinLimits(
    { runtimeMode: "approval-required", interactionMode: "plan" },
    {
      id: ThreadId.make("thread:target"),
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
  ).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error.code).toBe("interaction_mode_escalation_denied");
      expect(error.message).toContain("Thread thread:target runs in approval-required/default");
    }),
  ),
);

it.effect("allows a target at or below the caller's modes", () =>
  assertTargetWithinLimits(supervisedCaller, {
    id: ThreadId.make("thread:target"),
    runtimeMode: "approval-required",
    interactionMode: "plan",
  }),
);

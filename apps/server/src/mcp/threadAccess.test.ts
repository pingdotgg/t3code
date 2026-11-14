import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertFullAccess, readCaller, readThread } from "./threadAccess.ts";

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

it.effect("gives a thread caller the modes its active run executes in, not the thread's", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:restricted-run");
    const runId = RunId.make("run:restricted");
    const caller = yield* readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...client,
        client: undefined,
        thread: {
          threadId,
          providerSessionId: `provider:${threadId}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { activeRunId: runId })),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: runId, runtimeMode: "approval-required", interactionMode: "plan" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
    );

    expect(caller.limits).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
    const denied = yield* Effect.flip(assertFullAccess(caller, "Needs full access."));
    expect(denied.code).toBe("capability_denied");
  }),
);

it.effect("lowers a running caller's modes when its thread is lowered mid-run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:lowered-mid-run");
    const runId = RunId.make("run:sent-full-access");
    const caller = yield* readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...client,
        client: undefined,
        thread: {
          threadId,
          providerSessionId: `provider:${threadId}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              liveThreadShell(id, {
                activeRunId: runId,
                runtimeMode: "approval-required",
                interactionMode: "plan",
              }),
            ),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: runId, runtimeMode: "full-access", interactionMode: "default" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
    );

    expect(caller.limits).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  }),
);

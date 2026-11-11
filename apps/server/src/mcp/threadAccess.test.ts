import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readMissing = (threadId: ThreadId, existing: ReadonlyArray<ThreadId>) =>
  readThread(threadId).pipe(
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
    const error = yield* readMissing(bareId, [ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("points an unencoded delegated-task id at the encoded thread it belongs to", () =>
  Effect.gen(function* () {
    const commandId = `command:mcp:${bareId}:delegate-task:0e7d2c41-6b9a-4f3e-8d15-a2c4b6e8f019`;
    const encoded = ThreadId.make(`thread:delegated-task:${encodeURIComponent(commandId)}`);
    const error = yield* readMissing(ThreadId.make(`thread:delegated-task:${commandId}`), [
      encoded,
    ]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain(`\`${encoded}\``);
  }),
);

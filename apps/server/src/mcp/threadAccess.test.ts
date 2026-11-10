import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readInCurrentProject, readThread } from "./threadAccess.ts";

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

it.effect.each([
  { name: "retries in the project the thread moved to", currentProject: "target", reads: 2 },
  { name: "keeps the miss when the thread did not move", currentProject: "source", reads: 1 },
])("readInCurrentProject $name", ({ currentProject, reads }) =>
  Effect.gen(function* () {
    const attempted: Array<ProjectId> = [];
    const threads = {
      getThreadShell: (threadId: ThreadId) =>
        Effect.succeed({
          ...liveThreadShell(threadId),
          projectId: ProjectId.make(currentProject),
        }),
    };
    const exit = yield* readInCurrentProject(
      threads as never,
      bareId,
      ProjectId.make("source"),
      (projectId) => {
        attempted.push(projectId);
        return projectId === ProjectId.make("target")
          ? Effect.succeed("records")
          : Effect.fail({ _tag: "ThreadManagementThreadNotFoundError" as const });
      },
    ).pipe(Effect.exit);

    expect(attempted).toHaveLength(reads);
    expect(exit._tag).toBe(currentProject === "target" ? "Success" : "Failure");
  }),
);

import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildThreadReferencePage,
  hasUserThreadReference,
  normalizeThreadReferenceThreadId,
  threadRead,
  ThreadReferenceToolkitHandlersLive,
} from "./handlers.ts";
import { ThreadReferenceToolkit } from "./tools.ts";

const TestLayer = McpServer.toolkit(ThreadReferenceToolkit).pipe(
  Layer.provide(ThreadReferenceToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const makeMessage = (
  id: string,
  text: string,
  role: OrchestrationMessage["role"] = "user",
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const currentThreadId = ThreadId.make("thread-current");
const environmentId = EnvironmentId.make("environment-1");
const thread = {
  id: ThreadId.make("thread-referenced"),
  projectId: ProjectId.make("project-1"),
  title: "Referenced work",
  messages: [makeMessage("message-1", "abcdef"), makeMessage("message-2", "ghijkl")],
} as unknown as OrchestrationThread;
const currentThread = {
  ...thread,
  id: currentThreadId,
  messages: [
    makeMessage(
      "message-reference",
      `[Referenced work](t3-thread:///${environmentId}/${thread.id})`,
    ),
  ],
} as OrchestrationThread;
const invocation = {
  environmentId,
  threadId: currentThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["thread-reference"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const mcpServerClient = {
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
};
const projectionQueryFor = (sourceThread: OrchestrationThread) =>
  ({
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === sourceThread.id
          ? Option.some(sourceThread)
          : threadId === thread.id
            ? Option.some(thread)
            : Option.none(),
      ),
  }) as never;

it("paginates within a message without losing transcript text", () => {
  const first = buildThreadReferencePage(thread, {
    threadId: thread.id,
    maxChars: 1_000,
  });
  expect(first).toMatchObject({ nextCursor: null, totalMessages: 2 });

  const longThread = {
    ...thread,
    messages: [makeMessage("message-long", "a".repeat(1_100))],
  };
  const longFirst = buildThreadReferencePage(longThread, {
    threadId: thread.id,
    maxChars: 1_000,
  });
  expect(longFirst).toMatchObject({ nextCursor: "0:1000" });
  if ("_tag" in longFirst) throw new Error("unexpected cursor error");
  const longSecond = buildThreadReferencePage(longThread, {
    threadId: thread.id,
    cursor: longFirst.nextCursor!,
    maxChars: 1_000,
  });
  if ("_tag" in longSecond) throw new Error("unexpected cursor error");
  expect(longFirst.messages[0]?.text.length).toBe(1_000);
  expect(longSecond.messages[0]?.text.length).toBe(100);
  expect(longSecond.nextCursor).toBeNull();
});

it("continues pagination across an empty message at a page boundary", () => {
  const emptyMessageThread = {
    ...thread,
    messages: [
      makeMessage("message-full", "a".repeat(1_000)),
      makeMessage("message-empty", ""),
      makeMessage("message-tail", "tail"),
    ],
  };
  const first = buildThreadReferencePage(emptyMessageThread, {
    threadId: thread.id,
    maxChars: 1_000,
  });
  if ("_tag" in first) throw new Error("unexpected cursor error");
  expect(first.nextCursor).toBe("1:0");

  const second = buildThreadReferencePage(emptyMessageThread, {
    threadId: thread.id,
    cursor: first.nextCursor!,
    maxChars: 1_000,
  });
  if ("_tag" in second) throw new Error("unexpected cursor error");
  expect(second.messages.map(({ text }) => text)).toEqual(["", "tail"]);
  expect(second.nextCursor).toBeNull();
});

it.each([":", "0:", ":0", "0:0:garbage"])("rejects malformed cursor %s", (cursor) => {
  expect(
    buildThreadReferencePage(thread, {
      threadId: thread.id,
      cursor,
      maxChars: 1_000,
    } as never),
  ).toMatchObject({
    _tag: "ThreadReferenceInvalidCursorError",
    cursor,
  });
});

it("only authorizes user-supplied references from the invoking environment", () => {
  expect(hasUserThreadReference(currentThread, environmentId, thread.id)).toBe(true);
  expect(
    hasUserThreadReference(
      {
        ...currentThread,
        messages: [
          makeMessage(
            "message-punctuated-reference",
            `Continue from [Referenced work](t3-thread:///${environmentId}/${thread.id}), please.`,
          ),
        ],
      },
      environmentId,
      thread.id,
    ),
  ).toBe(true);
  expect(
    hasUserThreadReference(
      {
        ...currentThread,
        messages: [
          makeMessage(
            "message-assistant-reference",
            `[Referenced work](t3-thread:///${environmentId}/${thread.id})`,
            "assistant",
          ),
        ],
      },
      environmentId,
      thread.id,
    ),
  ).toBe(false);
  expect(
    hasUserThreadReference(
      {
        ...currentThread,
        messages: [
          makeMessage(
            "message-other-environment",
            `[Referenced work](t3-thread:///environment-2/${thread.id})`,
          ),
        ],
      },
      environmentId,
      thread.id,
    ),
  ).toBe(false);
});

it("normalizes model-facing thread reference inputs", () => {
  expect(normalizeThreadReferenceThreadId(thread.id, environmentId)).toBe(thread.id);
  expect(
    normalizeThreadReferenceThreadId(ThreadId.make(`${environmentId}/${thread.id}`), environmentId),
  ).toBe(thread.id);
  expect(
    normalizeThreadReferenceThreadId(
      ThreadId.make(`t3-thread:///${environmentId}/${thread.id}`),
      environmentId,
    ),
  ).toBe(thread.id);
  expect(
    normalizeThreadReferenceThreadId(
      ThreadId.make(`t3-thread:///environment-2/${thread.id}`),
      environmentId,
    ),
  ).toBe(`t3-thread:///environment-2/${thread.id}`);
});

it.effect("reads a referenced thread through the MCP toolkit", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const threadId of [
      thread.id,
      `${environmentId}/${thread.id}`,
      `t3-thread:///${environmentId}/${thread.id}`,
    ]) {
      const result = yield* server.callTool({
        name: "thread_read",
        arguments: { threadId },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threadId: thread.id,
        title: thread.title,
        totalMessages: 2,
      });
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
    Effect.provideService(ProjectionSnapshotQuery, projectionQueryFor(currentThread)),
    Effect.provide(TestLayer),
  ),
);

it.effect("rejects a thread that was not referenced by the invoking user", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: "thread_read",
      arguments: { threadId: thread.id },
    });
    expect(result.isError).toBe(true);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, mcpServerClient),
    Effect.provideService(
      ProjectionSnapshotQuery,
      projectionQueryFor({
        ...currentThread,
        messages: [makeMessage("message-without-reference", "No thread reference here.")],
      }),
    ),
    Effect.provide(TestLayer),
  ),
);

it.effect("preserves projection failures when a referenced thread cannot be loaded", () => {
  const repositoryError = new PersistenceSqlError({
    operation: "getThreadDetailById",
    detail: "database unavailable",
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(threadRead({ threadId: thread.id }));
    expect(error).toMatchObject({
      _tag: "ThreadReferenceUnavailableError",
      threadId: thread.id,
    });
    expect(error.cause).toBe(repositoryError);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadDetailById: (threadId: ThreadId) =>
        threadId === currentThread.id
          ? Effect.succeed(Option.some(currentThread))
          : Effect.fail(repositoryError),
    } as never),
  );
});

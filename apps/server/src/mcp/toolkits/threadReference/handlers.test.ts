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
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildThreadReferencePage,
  hasUserThreadReference,
  normalizeThreadReferenceThreadId,
  threadRead,
} from "./handlers.ts";

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

const environmentId = EnvironmentId.make("environment-1");
const sourceThreadId = ThreadId.make("thread-current");
const targetThread = {
  id: ThreadId.make("thread-referenced"),
  projectId: ProjectId.make("project-1"),
  title: "Referenced work",
  messages: [makeMessage("message-1", "abcdef"), makeMessage("message-2", "ghijkl")],
} as unknown as OrchestrationThread;
const sourceThread = {
  ...targetThread,
  id: sourceThreadId,
  messages: [
    makeMessage(
      "message-reference",
      `[Referenced work](t3-thread:///${environmentId}/${targetThread.id})`,
    ),
  ],
} as OrchestrationThread;
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: sourceThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["thread-reference"]),
  issuedAt: 1,
};

const projectionQueryFor = (source: OrchestrationThread) =>
  ({
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === source.id
          ? Option.some(source)
          : threadId === targetThread.id
            ? Option.some(targetThread)
            : Option.none(),
      ),
  }) as never;

it("paginates without losing text", () => {
  const longThread = {
    ...targetThread,
    messages: [makeMessage("message-long", "a".repeat(1_100))],
  };
  const first = buildThreadReferencePage(longThread, {
    threadId: targetThread.id,
    maxChars: 1_000,
  });
  if ("_tag" in first) throw new Error("unexpected cursor error");
  const second = buildThreadReferencePage(longThread, {
    threadId: targetThread.id,
    cursor: first.nextCursor!,
    maxChars: 1_000,
  });
  if ("_tag" in second) throw new Error("unexpected cursor error");

  expect(first.messages[0]?.text.length).toBe(1_000);
  expect(first.nextCursor).toBe("0:1000");
  expect(second.messages[0]?.text.length).toBe(100);
  expect(second.nextCursor).toBeNull();
});

it.each([":", "0:", ":0", "0:0:garbage"])('rejects malformed cursor "%s"', (cursor) => {
  expect(
    buildThreadReferencePage(targetThread, {
      threadId: targetThread.id,
      cursor,
      maxChars: 1_000,
    } as never),
  ).toMatchObject({ _tag: "ThreadReferenceInvalidCursorError", cursor });
});

it("authorizes only user-authored references from the invoking environment", () => {
  expect(hasUserThreadReference(sourceThread, environmentId, targetThread.id)).toBe(true);
  expect(
    hasUserThreadReference(
      {
        ...sourceThread,
        messages: [
          makeMessage(
            "assistant-reference",
            `[Referenced work](t3-thread:///${environmentId}/${targetThread.id})`,
            "assistant",
          ),
        ],
      },
      environmentId,
      targetThread.id,
    ),
  ).toBe(false);
  expect(
    hasUserThreadReference(
      {
        ...sourceThread,
        messages: [
          makeMessage(
            "other-environment",
            `[Referenced work](t3-thread:///environment-2/${targetThread.id})`,
          ),
        ],
      },
      environmentId,
      targetThread.id,
    ),
  ).toBe(false);
});

it("normalizes complete model-facing reference inputs", () => {
  expect(normalizeThreadReferenceThreadId(targetThread.id, environmentId)).toBe(targetThread.id);
  expect(
    normalizeThreadReferenceThreadId(
      ThreadId.make(`${environmentId}/${targetThread.id}`),
      environmentId,
    ),
  ).toBe(targetThread.id);
  expect(
    normalizeThreadReferenceThreadId(
      ThreadId.make(`t3-thread:///${environmentId}/${targetThread.id}`),
      environmentId,
    ),
  ).toBe(targetThread.id);
});

it.effect("reads only a task referenced by the invoking user", () =>
  Effect.gen(function* () {
    const result = yield* threadRead({ threadId: targetThread.id });
    expect(result).toMatchObject({
      threadId: targetThread.id,
      title: targetThread.title,
      totalMessages: 2,
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(ProjectionSnapshotQuery, projectionQueryFor(sourceThread)),
  ),
);

it.effect("rejects a task absent from the invoking user's message", () =>
  Effect.gen(function* () {
    const error = yield* threadRead({ threadId: targetThread.id }).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "ThreadReferenceUnavailableError",
      threadId: targetThread.id,
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(
      ProjectionSnapshotQuery,
      projectionQueryFor({
        ...sourceThread,
        messages: [makeMessage("unreferenced", "No task reference here")],
      }),
    ),
  ),
);

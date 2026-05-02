import { describe, expect, it } from "vitest";

import type { TaskIntakeMessage, TaskIntakeReply } from "./contracts.ts";
import { handleTaskIntakeMessage } from "./ingress.ts";
import type { TaskIntakeRuntime, TaskIntakeStore } from "./ports.ts";

function baseMessage(overrides?: Partial<TaskIntakeMessage>): TaskIntakeMessage {
  return {
    eventId: "linear:event-1",
    source: "linear",
    conversation: {
      source: "linear",
      externalLinkKind: "linear_issue",
      externalId: "issue-123",
      issueId: "issue-123",
      commentId: "comment-1",
      url: "https://linear.app/affil/issue/ENG-1/comment/comment-1",
    },
    messageId: "comment-1",
    actor: {
      displayName: "Vivek",
    },
    text: "@Engineering please investigate the failing checkout flow",
    receivedAt: "2026-04-12T12:00:00.000Z",
    url: "https://linear.app/affil/issue/ENG-1/comment/comment-1",
    ...overrides,
  };
}

function dependencies(options?: {
  readonly store?: Partial<TaskIntakeStore>;
  readonly runtime?: Partial<TaskIntakeRuntime>;
  readonly replies?: TaskIntakeReply[];
}) {
  const replies = options?.replies ?? [];

  return {
    store: {
      async resolveMessage() {
        return {
          status: "created" as const,
          taskId: "task-123",
          projectId: "project-123",
        };
      },
      async recordStartFailed() {},
      ...options?.store,
    },
    runtime: {
      async materializeTaskRuntime() {
        return {
          taskId: "task-123",
          workSessionId: "session-123",
          t3ProjectId: "project-456",
          t3ThreadId: "thread-456",
          branch: "ai/task-123",
          worktreePath: "/tmp/worktree",
          acceptedAt: "2026-04-12T12:00:01.000Z",
        };
      },
      ...options?.runtime,
    },
    replies: {
      async postReply(reply: TaskIntakeReply) {
        replies.push(reply);
        return {
          status: "posted" as const,
          externalMessageId: "reply-123",
        };
      },
    },
  };
}

describe("handleTaskIntakeMessage", () => {
  it("creates a task, materializes T3 runtime, and posts an acknowledgement", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    const deps = dependencies({ replies: postedReplies });

    const result = await handleTaskIntakeMessage(baseMessage(), deps);

    expect(result.ignored).toBe(false);
    expect(result.taskId).toBe("task-123");
    expect(result.t3ThreadId).toBe("thread-456");
    expect(result.resolution.type).toBe("create_task");
    expect(postedReplies).toHaveLength(1);
    expect(postedReplies[0]?.body).toContain("Task task-123 is underway.");
    expect(postedReplies[0]?.body).toContain("`thread-456`");
  });

  it("routes follow-up messages to an existing task without starting a new runtime", async () => {
    let materializeCalls = 0;
    const postedReplies: TaskIntakeReply[] = [];
    const deps = dependencies({
      replies: postedReplies,
      store: {
        async resolveMessage() {
          return {
            status: "routed_existing",
            taskId: "task-existing",
            projectId: "project-123",
            t3ThreadId: "thread-existing",
          };
        },
      },
      runtime: {
        async materializeTaskRuntime() {
          materializeCalls += 1;
          throw new Error("should not materialize");
        },
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({ eventId: "linear:event-2", messageId: "comment-2" }),
      deps,
    );

    expect(materializeCalls).toBe(0);
    expect(result.resolution.type).toBe("route_existing_task");
    expect(result.taskId).toBe("task-existing");
    expect(postedReplies[0]?.body).toContain("routed this follow-up");
  });

  it("skips duplicate events without posting another reply", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    const deps = dependencies({
      replies: postedReplies,
      store: {
        async resolveMessage() {
          return {
            status: "duplicate",
            taskId: "task-123",
          };
        },
      },
    });

    const result = await handleTaskIntakeMessage(baseMessage(), deps);

    expect(result.ignored).toBe(true);
    expect(result.resolution.type).toBe("ignore");
    expect(postedReplies).toHaveLength(0);
  });

  it("asks for clarification when the message is ambiguous", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    let resolveCalls = 0;
    const deps = dependencies({
      replies: postedReplies,
      store: {
        async resolveMessage() {
          resolveCalls += 1;
          throw new Error("should not create");
        },
      },
    });

    const result = await handleTaskIntakeMessage(baseMessage({ text: "@Engineering" }), deps);

    expect(resolveCalls).toBe(0);
    expect(result.resolution.type).toBe("needs_input");
    expect(postedReplies[0]?.body).toContain("need a clearer coding task");
  });

  it("records failed runtime starts and posts a start failure reply", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    let recordedFailure: string | undefined;
    const deps = dependencies({
      replies: postedReplies,
      runtime: {
        async materializeTaskRuntime() {
          throw new Error("bridge unavailable");
        },
      },
      store: {
        async recordStartFailed(input) {
          recordedFailure = input.summary;
        },
      },
    });

    const result = await handleTaskIntakeMessage(baseMessage(), deps);

    expect(result.taskId).toBe("task-123");
    expect(recordedFailure).toBe("bridge unavailable");
    expect(postedReplies[0]?.body).toContain("could not start Task task-123");
  });
});

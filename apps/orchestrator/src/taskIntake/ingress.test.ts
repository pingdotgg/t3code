import { describe, expect, it } from "vitest";

import type { TaskIntakeMessage, TaskIntakeReply } from "./contracts.ts";
import { handleTaskIntakeMessage } from "./ingress.ts";
import type { TaskIntakeReplyTransport, TaskIntakeRuntime, TaskIntakeStore } from "./ports.ts";

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
  readonly acknowledgements?: TaskIntakeMessage[];
}) {
  const replies = options?.replies ?? [];
  const acknowledgements = options?.acknowledgements ?? [];

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
      async continueTaskRuntime(input: {
        readonly eventId: string;
        readonly taskId: string;
        readonly workSessionId: string;
        readonly t3ThreadId: string;
        readonly prompt: string;
      }) {
        return {
          taskId: input.taskId,
          workSessionId: input.workSessionId,
          t3ThreadId: input.t3ThreadId,
          acceptedAt: "2026-04-12T12:00:02.000Z",
        };
      },
      ...options?.runtime,
    },
    replies: {
      async acknowledgeAccepted({ message }: { readonly message: TaskIntakeMessage }) {
        acknowledgements.push(message);
        return {
          status: "posted" as const,
          externalMessageId: `${message.messageId}:reaction:eyes`,
        };
      },
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
  it("creates a task, materializes T3 runtime, and reacts with eyes", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    const acknowledgements: TaskIntakeMessage[] = [];
    const deps = dependencies({ replies: postedReplies, acknowledgements });

    const result = await handleTaskIntakeMessage(baseMessage(), deps);

    expect(result.ignored).toBe(false);
    expect(result.taskId).toBe("task-123");
    expect(result.t3ThreadId).toBe("thread-456");
    expect(result.resolution.type).toBe("create_task");
    expect(postedReplies).toHaveLength(0);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.messageId).toBe("comment-1");
  });

  it("passes native image attachments into new task materialization", async () => {
    let materializedAttachments: unknown;
    const deps = dependencies({
      runtime: {
        async materializeTaskRuntime(input) {
          materializedAttachments = input.attachments;
          return {
            taskId: input.taskId,
            workSessionId: "session-123",
            t3ProjectId: "project-456",
            t3ThreadId: "thread-456",
            branch: "ai/task-123",
            worktreePath: "/tmp/worktree",
            acceptedAt: "2026-04-12T12:00:01.000Z",
          };
        },
      },
    });

    await handleTaskIntakeMessage(
      baseMessage({
        attachments: [
          {
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 4,
            dataUrl: "data:image/png;base64,dGVzdA==",
          },
          {
            type: "file",
            name: "notes.pdf",
            url: "https://files.slack.com/files-pri/T123-F124/notes.pdf",
          },
        ],
      }),
      deps,
    );

    expect(materializedAttachments).toEqual([
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,dGVzdA==",
      },
    ]);
  });

  it("routes new tasks with a [codex] marker to Codex GPT-5.5 fast mode without relaying the marker", async () => {
    let storedTitle: string | undefined;
    let storedText: string | undefined;
    let materialized:
      | {
          readonly initialPrompt: string;
          readonly modelSelection: unknown;
        }
      | undefined;
    const deps = dependencies({
      store: {
        async resolveMessage(input) {
          storedTitle = input.title;
          storedText = input.message.text;
          return {
            status: "created",
            taskId: "task-123",
            projectId: "project-123",
          };
        },
      },
      runtime: {
        async materializeTaskRuntime(input) {
          materialized = {
            initialPrompt: input.initialPrompt,
            modelSelection: input.modelSelection,
          };
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
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({
        text: "@Vevin [codex] please inspect the dashboard dependencies",
      }),
      deps,
    );

    expect(result.resolution.type).toBe("create_task");
    expect(storedTitle).toBe("@Vevin please inspect the dashboard dependencies");
    expect(storedText).toBe("@Vevin please inspect the dashboard dependencies");
    expect(materialized?.initialPrompt).toBe("@Vevin please inspect the dashboard dependencies");
    expect(materialized?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [{ id: "fastMode", value: true }],
    });
  });

  it("routes new tasks to Codex GPT-5.5 fast mode by default", async () => {
    let materialized:
      | {
          readonly modelSelection: unknown;
        }
      | undefined;
    const deps = dependencies({
      runtime: {
        async materializeTaskRuntime(input) {
          materialized = {
            modelSelection: input.modelSelection,
          };
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
      },
    });

    await handleTaskIntakeMessage(
      baseMessage({
        text: "@Vevin please inspect the dashboard dependencies",
      }),
      deps,
    );

    expect(materialized?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [{ id: "fastMode", value: true }],
    });
  });

  it("posts an optional task started card after materialization", async () => {
    const startedCards: Array<{ readonly taskId: string; readonly t3ThreadId: string }> = [];
    const deps = dependencies();
    (
      deps.replies as typeof deps.replies & {
        postTaskStartedCard: NonNullable<TaskIntakeReplyTransport["postTaskStartedCard"]>;
      }
    ).postTaskStartedCard = async ({ taskId, materialization }) => {
      startedCards.push({ taskId, t3ThreadId: materialization.t3ThreadId });
      return {
        status: "posted" as const,
        externalMessageId: "started-card-1",
      };
    };

    const result = await handleTaskIntakeMessage(baseMessage(), deps);

    expect(result.resolution.type).toBe("create_task");
    expect(startedCards).toEqual([{ taskId: "task-123", t3ThreadId: "thread-456" }]);
  });

  it("continues the existing T3 thread for materialized follow-up messages", async () => {
    let materializeCalls = 0;
    const acknowledgements: TaskIntakeMessage[] = [];
    let continued:
      | {
          readonly eventId: string;
          readonly taskId: string;
          readonly workSessionId: string;
          readonly t3ThreadId: string;
          readonly prompt: string;
          readonly attachments?: unknown;
        }
      | undefined;
    const postedReplies: TaskIntakeReply[] = [];
    const deps = dependencies({
      replies: postedReplies,
      acknowledgements,
      store: {
        async resolveMessage() {
          return {
            status: "routed_existing",
            taskId: "task-existing",
            projectId: "project-123",
            t3ThreadId: "thread-existing",
            workSessionId: "work-session-existing",
          };
        },
      },
      runtime: {
        async materializeTaskRuntime() {
          materializeCalls += 1;
          throw new Error("should not materialize");
        },
        async continueTaskRuntime(input) {
          continued = input;
          return {
            taskId: input.taskId,
            workSessionId: input.workSessionId,
            t3ThreadId: input.t3ThreadId,
            acceptedAt: "2026-04-12T12:00:02.000Z",
          };
        },
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({
        eventId: "linear:event-2",
        messageId: "comment-2",
        text: "Actually also update the failing cart test.",
        attachments: [
          {
            type: "image",
            name: "cart.png",
            mimeType: "image/png",
            sizeBytes: 4,
            dataUrl: "data:image/png;base64,Y2FydA==",
          },
        ],
      }),
      deps,
    );

    expect(materializeCalls).toBe(0);
    expect(continued).toMatchObject({
      eventId: "linear:event-2",
      taskId: "task-existing",
      workSessionId: "work-session-existing",
      t3ThreadId: "thread-existing",
    });
    expect(continued?.prompt).toBe("Actually also update the failing cart test.");
    expect(continued?.attachments).toEqual([
      {
        type: "image",
        name: "cart.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,Y2FydA==",
      },
    ]);
    expect(result.resolution.type).toBe("route_existing_task");
    expect(result.taskId).toBe("task-existing");
    expect(postedReplies).toHaveLength(0);
    expect(acknowledgements).toHaveLength(0);
  });

  it("routes follow-ups without continuing when runtime references are not available", async () => {
    let continueCalls = 0;
    const postedReplies: TaskIntakeReply[] = [];
    const acknowledgements: TaskIntakeMessage[] = [];
    const deps = dependencies({
      replies: postedReplies,
      acknowledgements,
      store: {
        async resolveMessage() {
          return {
            status: "routed_existing",
            taskId: "task-existing",
            projectId: "project-123",
          };
        },
      },
      runtime: {
        async continueTaskRuntime() {
          continueCalls += 1;
          throw new Error("should not continue");
        },
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({ eventId: "linear:event-3", messageId: "comment-3" }),
      deps,
    );

    expect(continueCalls).toBe(0);
    expect(result.resolution.type).toBe("route_existing_task");
    expect(result.taskId).toBe("task-existing");
    expect(postedReplies).toHaveLength(0);
    expect(acknowledgements).toHaveLength(0);
  });

  it("posts a failure reply when an existing task follow-up cannot be queued", async () => {
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
            workSessionId: "work-session-existing",
          };
        },
      },
      runtime: {
        async continueTaskRuntime() {
          throw new Error("Cannot recover thread because no provider resume state is persisted.");
        },
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({
        eventId: "linear:event-4",
        messageId: "comment-4",
        text: "Please continue this task.",
      }),
      deps,
    );

    expect(result.resolution.type).toBe("route_existing_task");
    expect(postedReplies).toHaveLength(1);
    expect(postedReplies[0]?.idempotencyKey).toBe("linear:event-4:follow-up-failed");
    expect(postedReplies[0]?.body).toContain(
      "I could not send this follow-up to Task task-existing.",
    );
    expect(postedReplies[0]?.body).toContain(
      "Cannot recover thread because no provider resume state is persisted.",
    );
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

  it("trusts short messages and relays them into a T3 task", async () => {
    const postedReplies: TaskIntakeReply[] = [];
    const acknowledgements: TaskIntakeMessage[] = [];
    let materializedPrompt: string | undefined;
    const deps = dependencies({
      replies: postedReplies,
      acknowledgements,
      runtime: {
        async materializeTaskRuntime(input) {
          materializedPrompt = input.initialPrompt;
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
      },
    });

    const result = await handleTaskIntakeMessage(
      baseMessage({ text: "@Engineering hello?" }),
      deps,
    );

    expect(result.resolution.type).toBe("create_task");
    expect(materializedPrompt).toBe("@Engineering hello?");
    expect(postedReplies).toHaveLength(0);
    expect(acknowledgements).toHaveLength(1);
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

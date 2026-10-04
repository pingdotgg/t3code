import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
  TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  threadHasInFlightTurn,
  threadHasQueuedTurnStart,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("expires an unadopted user message after the lifecycle grace period", () => {
    const thread = {
      ...readModel.threads[0]!,
      messages: [
        {
          id: MessageId.make("message-stale"),
          role: "user" as const,
          text: "stale",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    };

    expect(
      threadHasQueuedTurnStart(thread, {
        now: "2026-07-30T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      threadHasQueuedTurnStart(thread, {
        now: "2026-07-30T00:03:00.000Z",
      }),
    ).toBe(false);
  });

  it("treats a message with no accepted turn start as idle", () => {
    const thread = readModel.threads[0]!;
    const withMessage = {
      ...thread,
      messages: [
        {
          id: MessageId.make("msg-offline"),
          role: "user" as const,
          text: "sent while offline",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    expect(threadHasInFlightTurn(withMessage)).toBe(false);
  });

  it("keeps a thread with no completed turn sendable, as after a provider fork", () => {
    const thread = readModel.threads[0]!;
    expect(
      threadHasInFlightTurn({
        ...thread,
        latestTurn: null,
        session: { ...thread.session!, status: "error", activeTurnId: null },
        messages: [
          {
            id: MessageId.make("msg-forked"),
            role: "user",
            text: "forked history",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    ).toBe(false);
  });

  it("is busy from acceptance until the provider acknowledges", () => {
    const thread = readModel.threads[0]!;
    const pendingStart = {
      messageId: MessageId.make("msg-pending"),
      requestedAt: now,
    };
    expect(threadHasInFlightTurn({ ...thread, pendingTurnStart: pendingStart })).toBe(true);
    expect(
      threadHasInFlightTurn({
        ...thread,
        pendingTurnStart: pendingStart,
        messages: [
          {
            id: pendingStart.messageId,
            role: "user",
            text: "second send",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    ).toBe(true);
    expect(
      threadHasInFlightTurn({
        ...thread,
        pendingTurnStart: null,
        latestTurn: {
          turnId: TurnId.make("turn-running"),
          state: "running" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...thread.session!,
          status: "running",
          activeTurnId: TurnId.make("turn-running"),
        },
      }),
    ).toBe(true);
  });

  it("stays busy through an interrupt that arrives before acknowledgement", () => {
    const thread = readModel.threads[0]!;
    expect(
      threadHasInFlightTurn({
        ...thread,
        pendingTurnStart: { messageId: MessageId.make("msg-interrupt"), requestedAt: now },
      }),
    ).toBe(true);
  });

  it("treats a stopped turn as idle regardless of message timestamps", () => {
    const base = readModel.threads[0]!;
    const stopped = {
      ...base,
      pendingTurnStart: null,
      messages: [
        {
          id: MessageId.make("msg-stopped"),
          role: "user" as const,
          text: "stop this turn",
          attachments: [],
          turnId: null,
          streaming: false,
          // A manual stop can share its millisecond with the terminal turn.
          createdAt: now,
          updatedAt: now,
        },
      ],
      latestTurn: {
        turnId: TurnId.make("turn-stopped"),
        state: "interrupted" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    };
    expect(threadHasInFlightTurn(stopped)).toBe(false);
    expect(
      threadHasInFlightTurn({
        ...stopped,
        messages: [
          ...stopped.messages,
          {
            ...stopped.messages[0]!,
            id: MessageId.make("msg-after-stop"),
            createdAt: new Date(Date.parse(now) + 1).toISOString(),
          },
        ],
      }),
    ).toBe(false);
  });

  it("does not keep a thread in flight because of a failed start for an older message", () => {
    const thread = readModel.threads[0]!;
    expect(
      threadHasInFlightTurn({
        ...thread,
        pendingTurnStart: null,
        latestTurn: null,
        activities: [
          {
            id: EventId.make("provider-failure"),
            tone: "error",
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            payload: { detail: "network unavailable" },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});

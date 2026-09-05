import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("applyThreadDetailEvent", () => {
  describe("project events", () => {
    it("returns unchanged for project.created", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-1"),
        type: "project.created",
        payload: {
          projectId: ProjectId.make("project-1"),
          title: "T3 Code",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
          deletedAt: null,
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.created", () => {
    it("creates a fresh thread", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 1,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-2"),
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "New Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.id).toBe("thread-2");
        expect(result.thread.title).toBe("New Thread");
        expect(result.thread.branch).toBe("main");
        expect(result.thread.messages).toEqual([]);
        expect(result.thread.session).toBeNull();
      }
    });
  });

  describe("thread.deleted", () => {
    it("returns deleted signal", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T02:00:00.000Z",
        },
      });
      expect(result.kind).toBe("deleted");
    });
  });

  describe("thread.archived / thread.unarchived", () => {
    it("sets archivedAt and clears title regeneration", () => {
      const regeneratingThread: OrchestrationThread = {
        ...baseThread,
        titleRegeneration: {
          requestId: CommandId.make("regenerate-title"),
          startedAt: "2026-04-01T02:00:00.000Z",
        },
      };
      const result = applyThreadDetailEvent(regeneratingThread, {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T03:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.archived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          archivedAt: "2026-04-01T03:00:00.000Z",
          updatedAt: "2026-04-01T03:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBe("2026-04-01T03:00:00.000Z");
        expect(result.thread.titleRegeneration).toBeNull();
      }
    });

    it("clears archivedAt", () => {
      const archivedThread = { ...baseThread, archivedAt: "2026-04-01T03:00:00.000Z" };
      const result = applyThreadDetailEvent(archivedThread, {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unarchived",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt: "2026-04-01T04:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.archivedAt).toBeNull();
      }
    });
  });

  describe("thread.settled / thread.unsettled", () => {
    it("sets the settled override and timestamp", () => {
      const settledAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: settledAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.settled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          settledAt,
          updatedAt: settledAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe("settled");
        expect(result.thread.settledAt).toBe(settledAt);
      }
    });

    it.each([
      ["user", "active"],
      ["activity", null],
    ] as const)("unsettles for %s with override %s", (reason, settledOverride) => {
      const settledThread: OrchestrationThread = {
        ...baseThread,
        settledOverride: "settled",
        settledAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(settledThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unsettled",
        payload: {
          threadId: ThreadId.make("thread-1"),
          reason,
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.settledOverride).toBe(settledOverride);
        expect(result.thread.settledAt).toBeNull();
      }
    });
  });

  describe("thread.pinned / thread.unpinned", () => {
    it("sets pinnedAt", () => {
      const pinnedAt = "2026-04-01T05:00:00.000Z";
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: pinnedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.pinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          pinnedAt,
          updatedAt: pinnedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBe(pinnedAt);
      }
    });

    it("clears pinnedAt", () => {
      const pinnedThread: OrchestrationThread = {
        ...baseThread,
        pinnedAt: "2026-04-01T05:00:00.000Z",
      };
      const updatedAt = "2026-04-01T06:00:00.000Z";
      const result = applyThreadDetailEvent(pinnedThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: updatedAt,
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.unpinned",
        payload: {
          threadId: ThreadId.make("thread-1"),
          updatedAt,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.pinnedAt).toBeNull();
      }
    });
  });

  describe("thread.meta-updated", () => {
    it("patches title and branch", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 5,
        occurredAt: "2026-04-01T05:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.meta-updated",
        payload: {
          threadId: ThreadId.make("thread-1"),
          title: "Updated Title",
          branch: "feature/demo",
          updatedAt: "2026-04-01T05:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.title).toBe("Updated Title");
        expect(result.thread.branch).toBe("feature/demo");
        // Model selection should be unchanged since it wasn't in the payload
        expect(result.thread.modelSelection).toEqual(baseThread.modelSelection);
      }
    });

    it.each(["linkedPullRequest", "branchPullRequest"] as const)(
      "sets and clears %s without changing the other link",
      (field) => {
        const linkedPullRequest = {
          projectId: ProjectId.make("project-1"),
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
        };
        const otherField =
          field === "linkedPullRequest" ? "branchPullRequest" : "linkedPullRequest";
        const otherPullRequest = {
          ...linkedPullRequest,
          number: 43,
          url: "https://github.com/pingdotgg/t3code/pull/43",
        };
        const linked = applyThreadDetailEvent(
          { ...baseThread, [otherField]: otherPullRequest },
          {
            ...baseEventFields,
            sequence: 5,
            occurredAt: "2026-04-01T05:00:00.000Z",
            aggregateKind: "thread",
            aggregateId: ThreadId.make("thread-1"),
            type: "thread.meta-updated",
            payload: {
              threadId: ThreadId.make("thread-1"),
              [field]: linkedPullRequest,
              updatedAt: "2026-04-01T05:00:00.000Z",
            },
          },
        );

        expect(linked.kind).toBe("updated");
        if (linked.kind !== "updated") return;
        expect(linked.thread[field]).toEqual(linkedPullRequest);
        expect(linked.thread[otherField]).toEqual(otherPullRequest);

        const cleared = applyThreadDetailEvent(linked.thread, {
          ...baseEventFields,
          sequence: 6,
          occurredAt: "2026-04-01T06:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.meta-updated",
          payload: {
            threadId: ThreadId.make("thread-1"),
            [field]: null,
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        });

        expect(cleared.kind).toBe("updated");
        if (cleared.kind === "updated") {
          expect(cleared.thread[field]).toBeNull();
          expect(cleared.thread[otherField]).toEqual(otherPullRequest);
        }
      },
    );
  });

  describe("thread.message-sent", () => {
    it("appends a new message", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
          role: "user",
          text: "Hello, world!",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("keeps imported replies turnless when delivered again", () => {
      const event = {
        ...baseEventFields,
        sequence: 6,
        occurredAt: "2026-04-01T06:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: baseThread.id,
        type: "thread.message-sent",
        payload: {
          threadId: baseThread.id,
          messageId: MessageId.make("import:codex:session-1:000001"),
          role: "assistant",
          text: "Imported reply",
          turnId: null,
          streaming: false,
          createdAt: "2026-03-01T06:00:00.000Z",
          updatedAt: "2026-03-01T06:00:00.000Z",
        },
      } as const;

      const imported = applyThreadDetailEvent(baseThread, event);
      expect(imported.kind).toBe("updated");
      if (imported.kind !== "updated") return;
      expect(imported.thread.latestTurn).toBeNull();
      expect(imported.thread.checkpoints).toBe(baseThread.checkpoints);

      const repeated = applyThreadDetailEvent(imported.thread, { ...event, sequence: 7 });
      expect(repeated.kind).toBe("updated");
      if (repeated.kind !== "updated") return;
      expect(repeated.thread.messages).toEqual(imported.thread.messages);
      expect(repeated.thread.latestTurn).toBeNull();
      expect(repeated.thread.checkpoints).toBe(baseThread.checkpoints);
    });

    it("appends text for streaming messages", () => {
      const threadWithMessage: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithMessage, {
        ...baseEventFields,
        sequence: 7,
        occurredAt: "2026-04-01T06:01:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world!",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T06:01:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).toHaveLength(1);
        expect(result.thread.messages[0]?.text).toBe("Hello, world!");
      }
    });

    it("updates latestTurn for assistant messages with a turn", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Done.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-3");
      }
    });

    it("keeps latestTurn running for interim assistant messages while the session runs the turn", () => {
      const threadWithRunningSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningSession, {
        ...baseEventFields,
        sequence: 8,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-3"),
          role: "assistant",
          text: "Interim commentary between tool calls.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("running");
        expect(result.thread.latestTurn?.completedAt).toBeNull();
      }
    });

    it("keeps latestTurn and checkpoints references across a streaming delta", () => {
      const streamingThread: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-2"),
        },
        messages: [
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Hello",
            turnId: TurnId.make("turn-1"),
            streaming: true,
            createdAt: "2026-04-01T06:00:00.000Z",
            updatedAt: "2026-04-01T06:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T06:00:30.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(streamingThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: ", world",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T06:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages).not.toBe(streamingThread.messages);
        expect(result.thread.messages[0]?.text).toBe("Hello, world");
        expect(result.thread.latestTurn).toBe(streamingThread.latestTurn);
        expect(result.thread.checkpoints).toBe(streamingThread.checkpoints);
      }
    });

    it("replaces latestTurn and checkpoints when the first assistant message binds the turn", () => {
      const unboundThread: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T06:59:00.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T06:59:00.000Z",
          startedAt: "2026-04-01T06:59:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-04-01T06:59:30.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(unboundThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T07:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-2"),
          role: "assistant",
          text: "Hello",
          turnId: TurnId.make("turn-1"),
          streaming: true,
          createdAt: "2026-04-01T07:00:00.000Z",
          updatedAt: "2026-04-01T07:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn).not.toBe(unboundThread.latestTurn);
        expect(result.thread.latestTurn?.assistantMessageId).toBe("msg-2");
        expect(result.thread.checkpoints).not.toBe(unboundThread.checkpoints);
        expect(result.thread.checkpoints[0]?.assistantMessageId).toBe("msg-2");
      }
    });
  });

  describe("thread.session-set", () => {
    it("settles a running latestTurn when the session leaves the running status", () => {
      const threadWithRunningTurn: OrchestrationThread = {
        ...baseThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-01T07:00:00.000Z",
          startedAt: "2026-04-01T07:00:00.000Z",
          completedAt: null,
          assistantMessageId: MessageId.make("msg-3"),
        },
      };

      const result = applyThreadDetailEvent(threadWithRunningTurn, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "claude",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.latestTurn?.state).toBe("completed");
        expect(result.thread.latestTurn?.completedAt).toBe("2026-04-01T08:00:00.000Z");
      }
    });

    it("updates session and latestTurn for a running session", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 9,
        occurredAt: "2026-04-01T08:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: "2026-04-01T08:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("running");
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
        expect(result.thread.latestTurn?.state).toBe("running");
      }
    });
  });

  describe("thread.session-stop-requested", () => {
    it("marks session as stopped", () => {
      const threadWithSession: OrchestrationThread = {
        ...baseThread,
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-1"),
          lastError: null,
          updatedAt: "2026-04-01T08:00:00.000Z",
        },
      };

      const result = applyThreadDetailEvent(threadWithSession, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.session?.status).toBe("stopped");
        expect(result.thread.session?.activeTurnId).toBeNull();
      }
    });

    it("returns unchanged when no session exists", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 10,
        occurredAt: "2026-04-01T09:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.session-stop-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-04-01T09:00:00.000Z",
        },
      });
      expect(result.kind).toBe("unchanged");
    });
  });

  describe("thread.proposed-plan-upserted", () => {
    it("adds a proposed plan", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 11,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          proposedPlan: {
            id: "plan-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "## Plan\n- Do stuff",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-01T10:00:00.000Z",
            updatedAt: "2026-04-01T10:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.proposedPlans).toHaveLength(1);
        expect(result.thread.proposedPlans[0]?.id).toBe("plan-1");
      }
    });
  });

  describe("thread.activity-appended", () => {
    it("adds an activity", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(1);
        expect(result.thread.activities[0]?.kind).toBe("file-edit");
      }
    });

    it("preserves the complete activity history when live events arrive", () => {
      const existingActivities = Array.from({ length: 129 }, (_, index) => ({
        id: EventId.make(`activity-${index}`),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${index}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: index,
        createdAt: "2026-04-01T11:00:00.000Z",
      }));
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 130,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-129"),
              tone: "tool",
              kind: "command",
              summary: "Ran command 129",
              payload: {},
              turnId: TurnId.make("turn-1"),
              sequence: 129,
              createdAt: "2026-04-01T11:01:00.000Z",
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities).toHaveLength(130);
        expect(result.thread.activities[0]?.id).toBe("activity-0");
      }
    });

    it("re-sorts when an activity arrives out of order", () => {
      const makeActivity = (id: string, sequence: number) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran command ${sequence}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          activities: [makeActivity("activity-a", 1), makeActivity("activity-c", 3)],
        },
        {
          ...baseEventFields,
          sequence: 131,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: makeActivity("activity-b", 2),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
          "activity-c",
        ]);
      }
    });

    it("repairs snapshot ordering before fast-path appends engage", () => {
      const makeActivity = (id: string, sequence: number | null) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran ${id}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        ...(sequence === null ? {} : { sequence }),
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      // Snapshot loads deliver null-sequence rows first (DB order), which
      // activityOrder sorts last; an in-order live append must not freeze
      // that prefix.
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          activities: [makeActivity("activity-null", null), makeActivity("activity-a", 1)],
        },
        {
          ...baseEventFields,
          sequence: 135,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: makeActivity("activity-b", 2),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
          "activity-null",
        ]);
      }
    });

    it("dedupes a re-delivery arriving right after an in-order append", () => {
      const makeActivity = (id: string, sequence: number, summary: string) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const makeEvent = (sequence: number, activity: ReturnType<typeof makeActivity>) =>
        ({
          ...baseEventFields,
          sequence,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: { threadId: ThreadId.make("thread-1"), activity },
        }) as const;
      const first = applyThreadDetailEvent(
        { ...baseThread, activities: [makeActivity("activity-a", 1, "first")] },
        makeEvent(133, makeActivity("activity-b", 2, "second")),
      );
      expect(first.kind).toBe("updated");
      if (first.kind !== "updated") {
        return;
      }
      const second = applyThreadDetailEvent(
        first.thread,
        makeEvent(134, makeActivity("activity-c", 3, "third")),
      );
      expect(second.kind).toBe("updated");
      if (second.kind !== "updated") {
        return;
      }
      const third = applyThreadDetailEvent(
        second.thread,
        makeEvent(135, makeActivity("activity-c", 4, "third (redelivered)")),
      );
      expect(third.kind).toBe("updated");
      if (third.kind === "updated") {
        expect(third.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
          "activity-c",
        ]);
        expect(third.thread.activities[2]?.summary).toBe("third (redelivered)");
      }
    });

    it("replaces a re-delivered activity instead of duplicating it", () => {
      const makeActivity = (id: string, sequence: number, summary: string) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary,
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          activities: [
            makeActivity("activity-a", 1, "first"),
            makeActivity("activity-b", 2, "second"),
          ],
        },
        {
          ...baseEventFields,
          sequence: 132,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: makeActivity("activity-b", 2, "second (redelivered)"),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-a",
          "activity-b",
        ]);
        expect(result.thread.activities[1]?.summary).toBe("second (redelivered)");
      }
    });

    it("replaces earlier resolvable context-window updates for the same turn", () => {
      const contextWindowActivity = (id: string, sequence: number, usedTokens: unknown) => ({
        id: EventId.make(id),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens },
        turnId: TurnId.make("turn-1"),
        sequence,
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      const otherTurnActivity = contextWindowActivity("activity-other-turn", 2, 500);
      const existingActivities = [
        contextWindowActivity("activity-cw-1", 1, 1_000),
        { ...otherTurnActivity, turnId: TurnId.make("turn-0") },
        // Malformed row (no usedTokens): must survive, and must not be
        // treated as the latest value by consumers.
        contextWindowActivity("activity-cw-malformed", 3, undefined),
        contextWindowActivity("activity-cw-2", 4, 2_000),
      ];

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: existingActivities },
        {
          ...baseEventFields,
          sequence: 20,
          occurredAt: "2026-04-01T11:02:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: contextWindowActivity("activity-cw-3", 5, 3_000),
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        const ids = result.thread.activities.map((activity) => activity.id);
        // Same-turn resolvable rows collapse to the newest; the other turn's
        // row and the malformed row are untouched.
        expect(ids).toEqual(["activity-other-turn", "activity-cw-malformed", "activity-cw-3"]);
      }
    });

    it("does not collapse context-window history for a malformed update", () => {
      const resolvable = {
        id: EventId.make("activity-cw-resolvable"),
        tone: "info" as const,
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 1_000 },
        turnId: TurnId.make("turn-1"),
        sequence: 1,
        createdAt: "2026-04-01T11:00:00.000Z",
      };

      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [resolvable] },
        {
          ...baseEventFields,
          sequence: 21,
          occurredAt: "2026-04-01T11:03:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              ...resolvable,
              id: EventId.make("activity-cw-broken"),
              payload: { usedTokens: Number.NaN },
              sequence: 2,
            },
          },
        },
      );

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // The resolvable row must survive so consumers can still derive a
        // usage value by walking backwards past the malformed row.
        const ids = result.thread.activities.map((activity) => activity.id);
        expect(ids).toEqual(["activity-cw-resolvable", "activity-cw-broken"]);
      }
    });
  });

  describe("thread.turn-diff-completed", () => {
    it.each([null, "interrupted"] as const)(
      "adds a checkpoint without replacing a %s turn outcome",
      (previousState) => {
        const result = applyThreadDetailEvent(
          {
            ...baseThread,
            latestTurn:
              previousState === null
                ? null
                : {
                    turnId: TurnId.make("turn-1"),
                    state: previousState,
                    requestedAt: "2026-04-01T11:00:00.000Z",
                    startedAt: "2026-04-01T11:00:00.000Z",
                    completedAt: "2026-04-01T12:00:00.000Z",
                    assistantMessageId: null,
                  },
          },
          {
            ...baseEventFields,
            sequence: 13,
            occurredAt: "2026-04-01T12:00:00.000Z",
            aggregateKind: "thread",
            aggregateId: ThreadId.make("thread-1"),
            type: "thread.turn-diff-completed",
            payload: {
              threadId: ThreadId.make("thread-1"),
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("ref-1"),
              status: "ready",
              files: [],
              assistantMessageId: MessageId.make("msg-3"),
              completedAt: "2026-04-01T12:00:00.000Z",
            },
          },
        );

        expect(result.kind).toBe("updated");
        if (result.kind === "updated") {
          expect(result.thread.checkpoints).toHaveLength(1);
          expect(result.thread.latestTurn?.turnId).toBe("turn-1");
          expect(result.thread.latestTurn?.state).toBe(previousState ?? "completed");
        }
      },
    );
  });

  describe("thread.reverted", () => {
    it("keeps imported history and removes the first live prompt at checkpoint zero", () => {
      const threadWithImportedHistory: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("import:codex:session-1:000000"),
            role: "user",
            text: "Imported prompt",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
          {
            id: MessageId.make("import:codex:session-1:000001"),
            role: "assistant",
            text: "Imported answer",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-01T00:01:00.000Z",
            updatedAt: "2026-03-01T00:01:00.000Z",
          },
          {
            id: MessageId.make("live-user-message"),
            role: "user",
            text: "New work",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithImportedHistory, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T02:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: { threadId: ThreadId.make("thread-1"), turnCount: 0 },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages.map((message) => message.text)).toEqual([
          "Imported prompt",
          "Imported answer",
        ]);
      }
    });

    it("fallback-retains the earliest absolute timestamp across offsets", () => {
      const threadWithOffsetMessages: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("earlier-by-offset"),
            role: "user",
            text: "Earlier",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T10:30:00.000+02:00",
            updatedAt: "2026-04-01T10:30:00.000+02:00",
          },
          {
            id: MessageId.make("later-in-utc"),
            role: "user",
            text: "Later",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T09:00:00.000Z",
            updatedAt: "2026-04-01T09:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithOffsetMessages, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T10:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: { threadId: ThreadId.make("thread-1"), turnCount: 1 },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.messages.map((message) => message.id)).toEqual(["earlier-by-offset"]);
      }
    });

    it("filters entities to retained turns", () => {
      const threadWithData: OrchestrationThread = {
        ...baseThread,
        messages: [
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "First",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "assistant",
            text: "Response 1",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T02:00:00.000Z",
            updatedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            id: MessageId.make("msg-3"),
            role: "assistant",
            text: "Response 2",
            turnId: TurnId.make("turn-2"),
            streaming: false,
            createdAt: "2026-04-01T03:00:00.000Z",
            updatedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-2"),
            completedAt: "2026-04-01T02:00:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("msg-3"),
            completedAt: "2026-04-01T03:00:00.000Z",
          },
        ],
      };

      const result = applyThreadDetailEvent(threadWithData, {
        ...baseEventFields,
        sequence: 14,
        occurredAt: "2026-04-01T04:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.reverted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
        },
      });

      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        // turn-2 checkpoint is filtered out (turnCount 2 > revert target 1)
        expect(result.thread.checkpoints).toHaveLength(1);
        expect(result.thread.checkpoints[0]?.turnId).toBe("turn-1");
        // msg-3 (turn-2) is filtered, msg-1 (no turn) and msg-2 (turn-1) remain
        expect(result.thread.messages).toHaveLength(2);
        expect(result.thread.latestTurn?.turnId).toBe("turn-1");
      }
    });
  });

  describe("no-op events", () => {
    it("returns unchanged for approval-response-requested", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 15,
        occurredAt: "2026-04-01T13:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.approval-response-requested",
        payload: {
          threadId: ThreadId.make("thread-1"),
          requestId: "req-1",
          decision: "approve",
          createdAt: "2026-04-01T13:00:00.000Z",
        },
      } as any);
      expect(result.kind).toBe("unchanged");
    });
  });
});

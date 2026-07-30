import {
  MessageId,
  OrchestrationProposedPlanId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  cloneThreadForFork,
  forkedMessageId,
  forkedPlanId,
  forkedTurnId,
} from "./threadForking.ts";

const sourceThreadId = ThreadId.make("thread-source");
const targetThreadId = ThreadId.make("thread-target");
const turnId = TurnId.make("turn-source");
const messageId = MessageId.make("message-source");
const planId = OrchestrationProposedPlanId.make("plan-source");

const sourceThread = {
  id: sourceThreadId,
  projectId: ProjectId.make("project-1"),
  title: "Migration work",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/migration",
  worktreePath: "/repo/worktree",
  latestTurn: {
    turnId,
    state: "completed",
    requestedAt: "2026-07-29T10:00:00.000Z",
    startedAt: "2026-07-29T10:00:01.000Z",
    completedAt: "2026-07-29T10:01:00.000Z",
    assistantMessageId: messageId,
    sourceProposedPlan: { threadId: sourceThreadId, planId },
  },
  createdAt: "2026-07-29T09:00:00.000Z",
  updatedAt: "2026-07-29T10:01:00.000Z",
  archivedAt: "2026-07-29T11:00:00.000Z",
  settledOverride: "settled",
  settledAt: "2026-07-29T11:00:00.000Z",
  snoozedUntil: "2026-07-30T11:00:00.000Z",
  snoozedAt: "2026-07-29T11:00:00.000Z",
  deletedAt: null,
  messages: [
    {
      id: messageId,
      role: "assistant",
      text: "Done",
      attachments: [],
      turnId,
      createdAt: "2026-07-29T10:01:00.000Z",
      updatedAt: "2026-07-29T10:01:00.000Z",
      streaming: false,
    },
  ],
  proposedPlans: [
    {
      id: planId,
      turnId,
      planMarkdown: "# Plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-07-29T09:30:00.000Z",
      updatedAt: "2026-07-29T09:30:00.000Z",
    },
  ],
  activities: [],
  checkpoints: [],
  session: null,
} satisfies OrchestrationThread;

describe("cloneThreadForFork", () => {
  it("deterministically remaps durable history and clears ephemeral state", () => {
    const fork = cloneThreadForFork({
      sourceThread,
      targetThreadId,
      createdAt: "2026-07-29T12:00:00.000Z",
    });

    expect(fork.title).toBe("Migration work (fork)");
    expect(fork.messages[0]?.id).toBe(forkedMessageId(targetThreadId, messageId));
    expect(fork.messages[0]?.turnId).toBe(forkedTurnId(targetThreadId, turnId));
    expect(fork.proposedPlans[0]?.id).toBe(forkedPlanId(targetThreadId, planId));
    expect(fork.latestTurn?.sourceProposedPlan).toEqual({
      threadId: targetThreadId,
      planId: forkedPlanId(targetThreadId, planId),
    });
    expect(fork.session).toBeNull();
    expect(fork.checkpoints).toEqual([]);
    expect(fork.archivedAt).toBeNull();
    expect(fork.settledAt).toBeNull();
    expect(fork.snoozedUntil).toBeNull();
  });

  it("generates stable IDs when a fork event is replayed", () => {
    expect(forkedMessageId(targetThreadId, messageId)).toBe(
      forkedMessageId(targetThreadId, messageId),
    );
    expect(forkedTurnId(targetThreadId, turnId)).toBe(forkedTurnId(targetThreadId, turnId));
  });
});

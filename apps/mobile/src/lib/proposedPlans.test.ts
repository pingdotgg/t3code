import { describe, expect, it } from "vite-plus/test";

import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationProposedPlan,
} from "@t3tools/contracts";

import {
  buildImplementPlanTurnInput,
  deriveRelevantProposedPlan,
  hasActionableProposedPlan,
  IMPLEMENT_PLAN_MESSAGE_TEXT,
  isActionableProposedPlan,
} from "./proposedPlans";

function makePlan(
  input: Partial<OrchestrationProposedPlan> & Pick<OrchestrationProposedPlan, "id">,
): OrchestrationProposedPlan {
  return {
    turnId: null,
    planMarkdown: "# Plan\n\nDo the thing.",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...input,
  };
}

describe("deriveRelevantProposedPlan", () => {
  it("returns null when the thread has no proposed plans", () => {
    expect(deriveRelevantProposedPlan({ proposedPlans: [], latestTurnId: null })).toBeNull();
  });

  it("prefers the newest plan produced by the latest turn", () => {
    const olderTurnPlan = makePlan({
      id: "plan-older-turn",
      turnId: TurnId.make("turn-1"),
      updatedAt: "2026-04-03T00:00:00.000Z",
    });
    const latestTurnPlan = makePlan({
      id: "plan-latest-turn",
      turnId: TurnId.make("turn-2"),
      updatedAt: "2026-04-02T00:00:00.000Z",
    });

    const relevant = deriveRelevantProposedPlan({
      proposedPlans: [olderTurnPlan, latestTurnPlan],
      latestTurnId: TurnId.make("turn-2"),
    });

    expect(relevant?.id).toBe("plan-latest-turn");
  });

  it("falls back to the newest plan overall when the latest turn proposed none", () => {
    const older = makePlan({ id: "plan-1", updatedAt: "2026-04-01T00:00:00.000Z" });
    const newer = makePlan({ id: "plan-2", updatedAt: "2026-04-02T00:00:00.000Z" });

    const relevant = deriveRelevantProposedPlan({
      proposedPlans: [older, newer],
      latestTurnId: TurnId.make("turn-without-plan"),
    });

    expect(relevant?.id).toBe("plan-2");
  });
});

describe("hasActionableProposedPlan", () => {
  it("is false with no plans", () => {
    expect(hasActionableProposedPlan({ proposedPlans: [], latestTurnId: null })).toBe(false);
  });

  it("is true when the relevant plan is not implemented yet", () => {
    const plan = makePlan({ id: "plan-1" });
    expect(hasActionableProposedPlan({ proposedPlans: [plan], latestTurnId: null })).toBe(true);
  });

  it("is false once the relevant plan is implemented", () => {
    const plan = makePlan({ id: "plan-1", implementedAt: "2026-04-02T00:00:00.000Z" });
    expect(hasActionableProposedPlan({ proposedPlans: [plan], latestTurnId: null })).toBe(false);
  });

  it("follows the latest turn's plan even when an older unimplemented plan exists", () => {
    const olderPending = makePlan({
      id: "plan-older",
      turnId: TurnId.make("turn-1"),
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    const latestImplemented = makePlan({
      id: "plan-latest",
      turnId: TurnId.make("turn-2"),
      updatedAt: "2026-04-02T00:00:00.000Z",
      implementedAt: "2026-04-03T00:00:00.000Z",
    });

    expect(
      hasActionableProposedPlan({
        proposedPlans: [olderPending, latestImplemented],
        latestTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });
});

describe("isActionableProposedPlan", () => {
  it("tracks implementedAt", () => {
    expect(isActionableProposedPlan(makePlan({ id: "plan-1" }))).toBe(true);
    expect(
      isActionableProposedPlan(
        makePlan({ id: "plan-1", implementedAt: "2026-04-02T00:00:00.000Z" }),
      ),
    ).toBe(false);
  });
});

describe("buildImplementPlanTurnInput", () => {
  it("starts a default-mode turn sourced from the proposed plan", () => {
    const threadId = ThreadId.make("thread-1");
    const input = buildImplementPlanTurnInput({
      threadId,
      planId: "plan-1",
      runtimeMode: "full-access",
      commandId: CommandId.make("command-1"),
      messageId: MessageId.make("message-1"),
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    expect(input).toEqual({
      commandId: "command-1",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: IMPLEMENT_PLAN_MESSAGE_TEXT,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-04-01T00:00:00.000Z",
    });
  });
});

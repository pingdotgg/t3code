import { TurnId, type OrchestrationProposedPlan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  findActiveProposedPlan,
  hasUnimplementedProposedPlan,
  proposedPlanTitle,
} from "./proposedPlan.ts";

function makePlan(overrides: Partial<OrchestrationProposedPlan> = {}): OrchestrationProposedPlan {
  return {
    id: overrides.id ?? "plan-1",
    turnId: overrides.turnId ?? null,
    planMarkdown: overrides.planMarkdown ?? "# Title\n\n- step 1",
    implementedAt: overrides.implementedAt ?? null,
    implementationThreadId: overrides.implementationThreadId ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
    ...overrides,
  } as OrchestrationProposedPlan;
}

function settledTurn(turnId: string) {
  return {
    turnId,
    startedAt: "2026-01-01T00:00:01Z",
    completedAt: "2026-01-01T00:00:02Z",
  };
}

describe("proposedPlanTitle", () => {
  it("reads the first markdown heading as the plan title", () => {
    expect(proposedPlanTitle("# Integrate RPC\n\nBody")).toBe("Integrate RPC");
  });

  it("returns null when the plan has no heading", () => {
    expect(proposedPlanTitle("- step 1")).toBeNull();
  });
});

describe("buildPlanImplementationPrompt", () => {
  it("formats the plan as the implementation handoff prompt", () => {
    expect(buildPlanImplementationPrompt("## Ship it\n\n- step 1\n")).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
    );
  });
});

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("drops the redundant title heading and preserves the following markdown lines", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        "# Integrate RPC\n\n## Summary\n\n- step 1\n- step 2",
        {
          maxLines: 4,
        },
      ),
    ).toBe("- step 1\n- step 2");
  });

  it("appends an ellipsis when the preview truncates the plan", () => {
    const markdown = [
      "# Plan",
      "",
      ...Array.from({ length: 12 }, (_, i) => `- step ${i + 1}`),
    ].join("\n");
    const preview = buildCollapsedProposedPlanPreviewMarkdown(markdown, { maxLines: 4 });
    expect(preview.endsWith("...")).toBe(true);
    expect(preview).not.toContain("- step 12");
  });
});

describe("findActiveProposedPlan", () => {
  it("returns the latest-turn plan once the turn settled", () => {
    const plan = findActiveProposedPlan({
      proposedPlans: [makePlan({ turnId: TurnId.make("turn-1") })],
      latestTurn: settledTurn("turn-1"),
      session: null,
      threadId: "thread-1",
    });
    expect(plan?.id).toBe("plan-1");
    expect(plan?.threadId).toBe("thread-1");
  });

  it("falls back to the newest plan when the latest turn has none", () => {
    const plan = findActiveProposedPlan({
      proposedPlans: [
        makePlan({ id: "old", turnId: TurnId.make("turn-1"), updatedAt: "2026-01-01T00:00:00Z" }),
        makePlan({ id: "new", turnId: TurnId.make("turn-2"), updatedAt: "2026-01-02T00:00:00Z" }),
      ],
      latestTurn: settledTurn("turn-3"),
      session: null,
      threadId: "thread-1",
    });
    expect(plan?.id).toBe("new");
  });

  it("waits for the running session to settle before showing the plan", () => {
    const plan = findActiveProposedPlan({
      proposedPlans: [makePlan({ turnId: TurnId.make("turn-1") })],
      latestTurn: settledTurn("turn-1"),
      session: { status: "running" },
      threadId: "thread-1",
    });
    expect(plan).toBeNull();
  });

  it("hides an implemented plan", () => {
    const plan = findActiveProposedPlan({
      proposedPlans: [makePlan({ implementedAt: "2026-01-02T00:00:00Z" })],
      latestTurn: settledTurn("turn-1"),
      session: null,
      threadId: "thread-1",
    });
    expect(plan).toBeNull();
  });

  it("returns null while the latest turn has not completed", () => {
    const plan = findActiveProposedPlan({
      proposedPlans: [makePlan({ turnId: TurnId.make("turn-1") })],
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        startedAt: "2026-01-01T00:00:01Z",
        completedAt: null,
      },
      session: null,
      threadId: "thread-1",
    });
    expect(plan).toBeNull();
  });
});

describe("hasUnimplementedProposedPlan", () => {
  it("mirrors the server flag: the newest plan decides", () => {
    expect(hasUnimplementedProposedPlan([])).toBe(false);
    expect(hasUnimplementedProposedPlan([makePlan()])).toBe(true);
    expect(
      hasUnimplementedProposedPlan([makePlan({ implementedAt: "2026-01-02T00:00:00Z" })]),
    ).toBe(false);
    expect(
      hasUnimplementedProposedPlan([
        makePlan({ id: "a", updatedAt: "2026-01-01T00:00:00Z" }),
        makePlan({
          id: "b",
          updatedAt: "2026-01-02T00:00:00Z",
          implementedAt: "2026-01-02T00:00:00Z",
        }),
      ]),
    ).toBe(false);
  });
});

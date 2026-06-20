import { describe, expect, it } from "bun:test";

import type { OrchestrationThread } from "./connection.ts";
import {
  findLatestProposedPlan,
  latestActionableProposedPlan,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan.ts";

type Plan = OrchestrationThread["proposedPlans"][number];

const plan = (over: Partial<Plan>): Plan =>
  ({
    id: "p1",
    turnId: null,
    planMarkdown: "# Plan\n\nDo the thing.",
    implementedAt: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  }) as Plan;

const thread = (over: Partial<OrchestrationThread>): OrchestrationThread =>
  ({ proposedPlans: [], latestTurn: null, ...over }) as unknown as OrchestrationThread;

describe("proposedPlanTitle / stripDisplayedPlanMarkdown", () => {
  it("Given a markdown heading, then the title is its text", () => {
    expect(proposedPlanTitle("## Refactor parser\n\nbody")).toBe("Refactor parser");
  });

  it("Given no heading, then the title is null", () => {
    expect(proposedPlanTitle("just text")).toBeNull();
  });

  it("strips the leading title heading from the body", () => {
    expect(stripDisplayedPlanMarkdown("# Plan\n\nStep one")).toBe("Step one");
  });

  it("also strips a redundant Summary heading", () => {
    expect(stripDisplayedPlanMarkdown("# Plan\n\n## Summary\n\nStep one")).toBe("Step one");
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers a plan from the latest turn over a newer plan from another turn", () => {
    const result = findLatestProposedPlan(
      [
        plan({ id: "a", turnId: "t1" as never, updatedAt: "2026-06-19T00:00:01.000Z" }),
        plan({ id: "b", turnId: "t2" as never, updatedAt: "2026-06-19T00:00:09.000Z" }),
      ],
      "t1",
    );
    expect(result?.id).toBe("a");
  });

  it("falls back to the most recently updated plan when no turn matches", () => {
    const result = findLatestProposedPlan(
      [
        plan({ id: "a", updatedAt: "2026-06-19T00:00:01.000Z" }),
        plan({ id: "b", updatedAt: "2026-06-19T00:00:09.000Z" }),
      ],
      "missing",
    );
    expect(result?.id).toBe("b");
  });
});

describe("latestActionableProposedPlan", () => {
  it("Given an unimplemented plan, then it returns the title and body", () => {
    const result = latestActionableProposedPlan(
      thread({ proposedPlans: [plan({ planMarkdown: "# Refactor\n\nStep one" })] }),
    );
    expect(result).toEqual({ id: "p1", title: "Refactor", body: "Step one" });
  });

  it("Given an already-implemented plan, then it returns null", () => {
    const result = latestActionableProposedPlan(
      thread({ proposedPlans: [plan({ implementedAt: "2026-06-19T00:00:10.000Z" })] }),
    );
    expect(result).toBeNull();
  });

  it("Given no proposed plans, then it returns null", () => {
    expect(latestActionableProposedPlan(thread({}))).toBeNull();
  });
});

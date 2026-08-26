import type { PostHogReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveReportDecision } from "./reportVerdict";

function report(overrides: Partial<Omit<PostHogReport, "id">> & { id: string }): PostHogReport {
  return {
    title: `Report ${overrides.id}`,
    summary: null,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    source_products: [],
    ...overrides,
  } as PostHogReport;
}

const noPr = { hasExistingPr: false };

describe("report decisions", () => {
  it("shows the agent's reasoning where it is the ask", () => {
    for (const entry of [
      report({ id: "a", actionability: "requires_human_input" }),
      report({ id: "b", status: "pending_input" }),
      report({ id: "c", already_addressed: true }),
      report({ id: "d", actionability: "not_actionable" }),
    ]) {
      expect(deriveReportDecision(entry, noPr).showsReasoning).toBe(true);
    }
  });

  it("keeps research notes out of verdicts whose action speaks for itself", () => {
    const readyToReview = deriveReportDecision(report({ id: "pr" }), { hasExistingPr: true });
    expect(readyToReview.showsReasoning).toBe(false);
    expect(readyToReview.primary?.kind).toBe("review-pr");

    const actionable = deriveReportDecision(
      report({ id: "go", actionability: "immediately_actionable" }),
      noPr,
    );
    expect(actionable.showsReasoning).toBe(false);
    expect(actionable.primary?.kind).toBe("implement");
  });

  it("treats pending_input as the same ask as requires_human_input", () => {
    const decision = deriveReportDecision(report({ id: "p", status: "pending_input" }), noPr);
    expect(decision.verdict.title).toBe("Needs you, not an agent");
    expect(decision.primary?.kind).toBe("answer");
  });

  it("offers no action on a report nobody can act on", () => {
    expect(deriveReportDecision(report({ id: "r", status: "resolved" }), noPr).primary).toBeNull();
  });

  it("names what is on offer rather than the reader's obligation", () => {
    const decision = deriveReportDecision(
      report({ id: "go", actionability: "immediately_actionable" }),
      noPr,
    );
    expect(decision.verdict.title).toBe("An agent can fix this");
  });

  it("does not claim a report is ready when nothing judged it", () => {
    const decision = deriveReportDecision(report({ id: "unjudged" }), noPr);
    expect(decision.verdict.title).toBe("Not classified yet");
    expect(decision.verdict.tone).toBe("info");
  });
});

import type { OrchestrationThread } from "./connection.ts";

// Selecting and presenting a thread's proposed plan — a trimmed port of the web
// client's session-logic.findLatestProposedPlan + proposedPlan.ts helpers. Pure:
// MessagesTimeline renders the result as a card (mirroring ProposedPlanCard).

type ProposedPlan = OrchestrationThread["proposedPlans"][number];

export interface ActionableProposedPlan {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** First markdown heading text, used as the card title. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/**
 * Drop the leading title heading (and a redundant "Summary" heading) so the card
 * body doesn't repeat what the card title already shows.
 */
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  const firstHeading = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeading?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  }
  return sourceLines.join("\n");
}

function pickLatest(plans: ReadonlyArray<ProposedPlan>): ProposedPlan | null {
  return (
    [...plans]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
      .at(-1) ?? null
  );
}

/** Prefer a plan from the latest turn; otherwise the most recently updated. */
export function findLatestProposedPlan(
  plans: ReadonlyArray<ProposedPlan>,
  latestTurnId: string | null,
): ProposedPlan | null {
  if (latestTurnId) {
    const fromTurn = pickLatest(plans.filter((plan) => plan.turnId === latestTurnId));
    if (fromTurn) return fromTurn;
  }
  return pickLatest(plans);
}

/**
 * The proposed plan awaiting action (not yet implemented), or null. This is what
 * the conversation surfaces as a card after a plan-mode turn.
 */
export function latestActionableProposedPlan(
  detail: OrchestrationThread,
): ActionableProposedPlan | null {
  const plan = findLatestProposedPlan(detail.proposedPlans, detail.latestTurn?.turnId ?? null);
  if (!plan || plan.implementedAt !== null) return null;
  const body = stripDisplayedPlanMarkdown(plan.planMarkdown).trim();
  return {
    id: plan.id,
    title: proposedPlanTitle(plan.planMarkdown) ?? "Proposed plan",
    body: body.length > 0 ? body : plan.planMarkdown.trim(),
  };
}

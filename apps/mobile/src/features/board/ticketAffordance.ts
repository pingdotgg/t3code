import type {
  StepRunId,
  WorkflowLaneActionView,
  WorkflowStepRunView,
  WorkflowTicketDetailView,
} from "@t3tools/contracts";

/**
 * Returns true when the ticket is owned by an external sync source
 * (i.e. its title/description are managed by the source provider and
 * should be treated as read-only in the UI).
 */
export function isTicketSourceOwned(
  detail: Pick<WorkflowTicketDetailView, "syncedSource">,
): boolean {
  return Boolean(detail.syncedSource);
}

/**
 * Discriminated union describing what the human can do with a ticket that
 * surfaced in the "Needs you" inbox / notification deep-link. The `kind` is
 * driven primarily off the server-projected `ticket.attentionKind`; the awaiting
 * step's `providerResponseKind` is only consulted as a fallback. Every variant
 * carries `laneActions` so the action sheet can always offer manual lane moves.
 */
export type TicketAffordance =
  | {
      readonly kind: "answer";
      readonly stepRunId: StepRunId;
      readonly question: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "approve";
      readonly stepRunId: StepRunId;
      readonly question: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "blocked";
      readonly blockReason: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "comment";
      readonly laneActions: readonly WorkflowLaneActionView[];
    };

function findAwaitingStep(detail: WorkflowTicketDetailView): WorkflowStepRunView | undefined {
  return detail.steps.find((step) => step.status === "awaiting_user");
}

/**
 * Maps a ticket detail view onto the single best human affordance.
 *
 * Mapping rules (see TicketActionSheetScreen for the UI):
 * - `waiting_for_input` (or awaiting step `providerResponseKind === "user-input"`)
 *   → `answer`, requires the awaiting step's `stepRunId`; degrades to `comment`
 *   when no awaiting step is present.
 * - `waiting_for_approval` (or `providerResponseKind === "request"`) → `approve`,
 *   same `stepRunId` requirement / degrade.
 * - `blocked` attention OR `ticket.status === "blocked"` → `blocked`.
 * - otherwise → `comment`.
 */
export function selectTicketAffordance(detail: WorkflowTicketDetailView): TicketAffordance {
  const ticket = detail.ticket;
  const awaitingStep = findAwaitingStep(detail);
  const laneActions = ticket.currentLane?.actions ?? [];

  const attentionKind = ticket.attentionKind;
  const providerResponseKind = awaitingStep?.providerResponseKind ?? null;

  const wantsInput =
    attentionKind === "waiting_for_input" ||
    (attentionKind === undefined && providerResponseKind === "user-input");
  const wantsApproval =
    attentionKind === "waiting_for_approval" ||
    (attentionKind === undefined &&
      (providerResponseKind === "request" ||
        // Mirror web's isAwaitingApprovalRequestStep fallback: an explicit
        // approval step awaiting the user with no providerResponseKind is
        // still an approval request.
        (awaitingStep?.stepType === "approval" && providerResponseKind === null)));
  const isBlocked = attentionKind === "blocked" || ticket.status === "blocked";

  if (wantsInput) {
    if (awaitingStep) {
      return {
        kind: "answer",
        stepRunId: awaitingStep.stepRunId,
        question: awaitingStep.waitingReason ?? ticket.attentionReason ?? null,
        laneActions,
      };
    }
    return { kind: "comment", laneActions };
  }

  if (wantsApproval) {
    if (awaitingStep) {
      return {
        kind: "approve",
        stepRunId: awaitingStep.stepRunId,
        question: awaitingStep.waitingReason ?? ticket.attentionReason ?? null,
        laneActions,
      };
    }
    return { kind: "comment", laneActions };
  }

  if (isBlocked) {
    return {
      kind: "blocked",
      blockReason: awaitingStep?.blockedReason ?? ticket.attentionReason ?? null,
      laneActions,
    };
  }

  return { kind: "comment", laneActions };
}

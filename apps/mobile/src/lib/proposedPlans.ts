import type {
  CommandId,
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationProposedPlan,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

/** Message text sent when the user accepts a proposed plan. Matches mac. */
export const IMPLEMENT_PLAN_MESSAGE_TEXT = "Implement the proposed plan.";

function comparePlans(left: OrchestrationProposedPlan, right: OrchestrationProposedPlan): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
}

/**
 * Picks the proposed plan the thread chrome should surface, mirroring the
 * server's `deriveHasActionableProposedPlan`
 * (apps/server/src/orchestration/Layers/ProjectionPipeline.ts): prefer the
 * newest plan produced by the latest turn; when that turn proposed none,
 * fall back to the newest plan overall. Returns `null` when the thread has
 * no proposed plans.
 */
export function deriveRelevantProposedPlan(input: {
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly latestTurnId: OrchestrationLatestTurn["turnId"] | null;
}): OrchestrationProposedPlan | null {
  if (input.proposedPlans.length === 0) {
    return null;
  }

  const sorted = [...input.proposedPlans].sort(comparePlans);
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        return plan;
      }
    }
  }

  return sorted[sorted.length - 1] ?? null;
}

/** A plan stays actionable until an implementation turn marks it implemented. */
export function isActionableProposedPlan(plan: OrchestrationProposedPlan): boolean {
  return plan.implementedAt === null;
}

/**
 * Mobile equivalent of the thread shell's `hasActionableProposedPlan` flag,
 * for contexts where only the thread detail (not the shell snapshot) is
 * available.
 */
export function hasActionableProposedPlan(input: {
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly latestTurnId: OrchestrationLatestTurn["turnId"] | null;
}): boolean {
  const plan = deriveRelevantProposedPlan(input);
  return plan !== null && isActionableProposedPlan(plan);
}

/**
 * Builds the `thread.turn.start` payload that begins implementing a proposed
 * plan. Implementation turns always run in the default interaction mode —
 * plan mode is what produced the plan being implemented (mac does the same).
 */
export function buildImplementPlanTurnInput(input: {
  readonly threadId: ThreadId;
  readonly planId: OrchestrationProposedPlan["id"];
  readonly runtimeMode: RuntimeMode;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
}) {
  return {
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: IMPLEMENT_PLAN_MESSAGE_TEXT,
      attachments: [],
    },
    runtimeMode: input.runtimeMode,
    interactionMode: "default" as const,
    sourceProposedPlan: {
      threadId: input.threadId,
      planId: input.planId,
    },
    createdAt: input.createdAt,
  };
}

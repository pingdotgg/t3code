import { createHash } from "node:crypto";
import type {
  ChildNudgeUpdate,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { childWakeReason } from "./childNudging.ts";
import { threadHasInFlightTurn, threadHasPendingInteraction } from "./commandInvariants.ts";

// Allow terminal-turn projections to settle before treating incomplete lifecycle evidence as final.
const SETTLEMENT_GRACE_MS = 2_000;
const MAX_STALL_SUMMARY_LENGTH = 1_000;

export interface DelegationSettlement {
  readonly completedAt: string;
  readonly turnId: TurnId;
  readonly outcome: "result-available" | "failed" | "blocked";
  readonly report: ChildNudgeUpdate;
}

export interface DelegationStallEpisode {
  readonly id: string;
  readonly stalledSince: string;
  readonly summary: string;
}

export type DelegationChildrenByParent = ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationThread>>;

interface PendingInteraction {
  readonly kind: "approval" | "input";
  readonly requestId: string;
  readonly createdAt: string;
}

export function indexDelegationChildren(
  threads: ReadonlyArray<OrchestrationThread>,
): DelegationChildrenByParent {
  const childrenByParent = new Map<ThreadId, OrchestrationThread[]>();
  for (const thread of threads) {
    if (thread.parentThreadId == null) continue;
    const children = childrenByParent.get(thread.parentThreadId);
    if (children) {
      children.push(thread);
    } else {
      childrenByParent.set(thread.parentThreadId, [thread]);
    }
  }
  return childrenByParent;
}

function requestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>).requestId;
  return typeof value === "string" ? value : null;
}

function pendingInteraction(child: OrchestrationThread): PendingInteraction | null {
  const pending = new Map<string, PendingInteraction>();
  for (const activity of child.activities.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const id = requestId(activity.payload);
    if (id === null) continue;
    if (activity.kind === "approval.requested") {
      pending.set(`approval:${id}`, {
        kind: "approval",
        requestId: id,
        createdAt: activity.createdAt,
      });
    } else if (activity.kind === "approval.resolved") {
      pending.delete(`approval:${id}`);
    } else if (activity.kind === "user-input.requested") {
      pending.set(`input:${id}`, { kind: "input", requestId: id, createdAt: activity.createdAt });
    } else if (activity.kind === "user-input.resolved") {
      pending.delete(`input:${id}`);
    }
  }
  return (
    [...pending.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.requestId.localeCompare(right.requestId),
    )[0] ?? null
  );
}

function latestTimestamp(
  ...timestamps: ReadonlyArray<string | null | undefined>
): string | undefined {
  return timestamps
    .filter((value): value is string => value !== null && value !== undefined)
    .sort()
    .at(-1);
}

function stallId(child: OrchestrationThread, condition: ReadonlyArray<unknown>): string {
  const delegation = child.nudging!.delegation!;
  return `delegation-stall:${createHash("sha256")
    .update(
      JSON.stringify([
        child.id,
        delegation.dispatchId ?? null,
        delegation.assignmentId,
        ...condition,
      ]),
    )
    .digest("hex")}`;
}

function boundedStallSummary(summary: string): string {
  return summary.length <= MAX_STALL_SUMMARY_LENGTH
    ? summary
    : `${summary.slice(0, MAX_STALL_SUMMARY_LENGTH - 3)}...`;
}

function queuedTurnFailureSummary(failureMessage: string | null): string {
  if (failureMessage === null) {
    return "no failure detail was recorded";
  }
  const firstLine = failureMessage.split(/\r?\n/, 1)[0]?.trim();
  const detail = firstLine && firstLine.length > 0 ? firstLine : "failure details were recorded";
  const boundedDetail = detail.length <= 300 ? detail : `${detail.slice(0, 297)}...`;
  return `${boundedDetail} Inspect the child for full details`;
}

function unsettledDelegationSummary(child: OrchestrationThread): string {
  const delegation = child.nudging!.delegation!;
  const latestTurn = child.latestTurn;
  const reason = !latestTurn
    ? "no turn is available to settle"
    : latestTurn.state !== "completed" &&
        latestTurn.state !== "error" &&
        latestTurn.state !== "interrupted"
      ? "the latest turn is not complete"
      : delegation.dispatchId !== undefined && delegation.dispatchTurnId == null
        ? "the dispatch turn is not bound"
        : delegation.dispatchTurnId != null && delegation.dispatchTurnId !== latestTurn.turnId
          ? "the dispatch turn fence does not match the latest turn"
          : delegation.assignedAt !== undefined && latestTurn.requestedAt < delegation.assignedAt
            ? "the latest turn predates the assignment"
            : delegation.pendingResponse != null || threadHasPendingInteraction(child)
              ? "a pending response is blocking settlement"
              : "settlement preconditions are not satisfied";
  return boundedStallSummary(`Delegation is idle but cannot settle because ${reason}.`);
}

function latestThreadActivityAt(thread: OrchestrationThread): string | undefined {
  return latestTimestamp(
    thread.updatedAt,
    thread.nudging?.delegation?.assignedAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    thread.session?.updatedAt,
    ...thread.activities.map((activity) => activity.createdAt),
  );
}

export function delegationStallEpisode(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  childrenByParent?: DelegationChildrenByParent,
): DelegationStallEpisode | null {
  const delegation = child.nudging?.delegation;
  if (
    !delegation ||
    delegation.followUp !== "automatic" ||
    delegation.completedAt !== null ||
    child.parentThreadId == null ||
    child.deletedAt !== null ||
    child.archivedAt !== null ||
    child.session?.status === "running" ||
    child.session?.activeTurnId != null ||
    child.latestTurn?.state === "running"
  ) {
    return null;
  }

  const idleSince =
    latestTimestamp(
      delegation.assignedAt,
      child.latestTurn?.completedAt,
      child.latestTurn?.requestedAt,
      child.session?.updatedAt,
    ) ?? child.createdAt;
  if (
    threadHasInFlightTurn(child) ||
    (child.queuedTurns ?? []).some((turn) => turn.failedAt === null)
  ) {
    return null;
  }
  const failedTurn = (child.queuedTurns ?? [])
    .filter((turn): turn is typeof turn & { readonly failedAt: string } => turn.failedAt !== null)
    .sort(
      (left, right) =>
        left.failedAt.localeCompare(right.failedAt) || left.id.localeCompare(right.id),
    )[0];
  if (failedTurn) {
    return {
      id: stallId(child, ["failed-queued-turn", failedTurn.id, failedTurn.failedAt]),
      stalledSince: latestTimestamp(idleSince, failedTurn.failedAt)!,
      summary: boundedStallSummary(
        `Delegation is idle with failed queued turn ${failedTurn.id}: ${queuedTurnFailureSummary(failedTurn.failureMessage)}.`,
      ),
    };
  }

  const interaction = pendingInteraction(child);
  if (interaction) {
    return {
      id: stallId(child, [interaction.kind, interaction.requestId, interaction.createdAt]),
      stalledSince: latestTimestamp(idleSince, interaction.createdAt)!,
      summary: boundedStallSummary(
        interaction.kind === "approval"
          ? `Delegation is idle with pending approval ${interaction.requestId}.`
          : `Delegation is idle with pending input ${interaction.requestId}.`,
      ),
    };
  }

  if (delegation.decision) {
    return {
      id: stallId(child, ["decision", delegation.decision.id]),
      stalledSince: idleSince,
      summary: boundedStallSummary(
        `Delegation is idle with open decision ${delegation.decision.id}: ${delegation.decision.decision?.question ?? delegation.decision.summary}`,
      ),
    };
  }

  const indexedChildren = childrenByParent ?? indexDelegationChildren(readModel.threads);
  const children = indexedChildren.get(child.id) ?? [];
  const unfinishedGrandchildren = children
    .filter(
      (descendant) =>
        descendant.deletedAt === null &&
        descendant.archivedAt === null &&
        descendant.nudging?.delegation?.followUp === "automatic" &&
        descendant.nudging.delegation.completedAt === null,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (unfinishedGrandchildren.length > 0) {
    if (
      unfinishedGrandchildren.some(
        (descendant) =>
          descendant.session?.status === "running" ||
          descendant.session?.activeTurnId != null ||
          descendant.latestTurn?.state === "running",
      )
    ) {
      return null;
    }
    const identities = unfinishedGrandchildren.map((descendant) => [
      descendant.id,
      descendant.nudging!.delegation!.assignmentId,
    ]);
    return {
      id: stallId(child, ["grandchildren", identities]),
      stalledSince: latestTimestamp(
        idleSince,
        ...unfinishedGrandchildren.map(latestThreadActivityAt),
      )!,
      summary: boundedStallSummary(
        `Delegation is idle with unfinished grandchildren: ${unfinishedGrandchildren
          .slice(0, 8)
          .map((descendant) => `${descendant.title} (${descendant.id})`)
          .join(
            ", ",
          )}${unfinishedGrandchildren.length > 8 ? `, and ${unfinishedGrandchildren.length - 8} more` : ""}.`,
      ),
    };
  }

  const settlementNotBefore = delegationSettlementNotBefore(child);
  if (settlementNotBefore !== null && Date.parse(settlementNotBefore) > Date.now()) {
    return null;
  }
  if (settleDelegation(readModel, child, indexedChildren) !== null) return null;

  return {
    id: stallId(child, [
      "unsettled",
      child.latestTurn?.turnId ?? null,
      delegation.dispatchTurnId ?? null,
    ]),
    stalledSince: latestThreadActivityAt(child) ?? idleSince,
    summary: unsettledDelegationSummary(child),
  };
}

export function delegationSettlementNotBefore(child: OrchestrationThread): string | null {
  const latestTurn = child.latestTurn;
  if (!latestTurn) {
    return null;
  }
  const awaitingCompletionEvidence =
    latestTurn.state === "completed" &&
    !child.activities.some(
      (activity) =>
        activity.kind === "insights.turn.completed" && activity.turnId === latestTurn.turnId,
    );
  if (latestTurn.state !== "interrupted" && !awaitingCompletionEvidence) {
    return null;
  }
  const settledAt =
    latestTurn.state === "interrupted"
      ? (latestTurn.completedAt ?? child.session?.updatedAt)
      : latestTurn.completedAt;
  if (settledAt === null || settledAt === undefined) {
    return null;
  }
  const timestamp = Date.parse(settledAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + SETTLEMENT_GRACE_MS).toISOString()
    : null;
}

export function settleDelegation(
  readModel: OrchestrationReadModel,
  child: OrchestrationThread,
  childrenByParent?: DelegationChildrenByParent,
): DelegationSettlement | null {
  const delegation = child.nudging?.delegation;
  const latestTurn = child.latestTurn;
  const childrenByParentIndex = childrenByParent ?? indexDelegationChildren(readModel.threads);
  const children = childrenByParentIndex.get(child.id) ?? [];
  if (
    !delegation ||
    delegation.completedAt !== null ||
    child.parentThreadId == null ||
    child.deletedAt !== null ||
    child.archivedAt !== null ||
    !latestTurn ||
    (latestTurn.state !== "completed" &&
      latestTurn.state !== "error" &&
      latestTurn.state !== "interrupted") ||
    child.session?.status === "running" ||
    child.session?.activeTurnId != null ||
    threadHasInFlightTurn(child) ||
    (child.queuedTurns?.length ?? 0) > 0 ||
    threadHasPendingInteraction(child) ||
    delegation.decision != null ||
    delegation.pendingResponse != null ||
    (delegation.dispatchId !== undefined && delegation.dispatchTurnId == null) ||
    (delegation.dispatchTurnId != null && delegation.dispatchTurnId !== latestTurn.turnId) ||
    (delegation.assignedAt !== undefined && latestTurn.requestedAt < delegation.assignedAt) ||
    children.some(
      (descendant) =>
        descendant.deletedAt === null &&
        descendant.archivedAt === null &&
        descendant.nudging?.delegation?.followUp === "automatic" &&
        descendant.nudging.delegation.completedAt === null,
    )
  ) {
    return null;
  }

  const completion = child.activities.findLast(
    (activity) =>
      activity.kind === "insights.turn.completed" && activity.turnId === latestTurn.turnId,
  );
  if (
    latestTurn.state === "completed" &&
    completion === undefined &&
    Date.parse(delegationSettlementNotBefore(child) ?? "") > Date.now()
  ) {
    return null;
  }
  const completionState =
    completion?.payload !== null &&
    typeof completion?.payload === "object" &&
    completion.payload !== undefined &&
    "state" in completion.payload
      ? completion.payload.state
      : undefined;
  const outcome =
    completionState === "failed" || latestTurn.state === "error"
      ? "failed"
      : latestTurn.state === "completed" &&
          (completionState === "completed" || completion === undefined)
        ? "result-available"
        : "blocked";
  const resultMessage = child.messages.findLast(
    (message) =>
      message.role === "assistant" && message.turnId === latestTurn.turnId && !message.streaming,
  );
  const reportId = delegation.dispatchId
    ? `assignment:${child.id}:${delegation.dispatchId}:${delegation.assignmentId}`
    : `assignment:${child.id}:${delegation.assignmentId}`;
  const summary =
    outcome === "result-available"
      ? `Child returned a result; task success and background completion are not verified.${resultMessage ? `\n${resultMessage.text.slice(0, 3000)}` : " No final result message was recorded."}`
      : outcome === "failed"
        ? "The delegated execution failed. Inspect the child for details."
        : "Delegated completion is unconfirmed or interrupted. Inspect the child before continuing.";

  return {
    completedAt: latestTurn.completedAt ?? completion?.createdAt ?? latestTurn.requestedAt,
    turnId: latestTurn.turnId,
    outcome,
    report: {
      id: reportId,
      assignmentId: delegation.assignmentId,
      ...(delegation.dispatchId ? { dispatchId: delegation.dispatchId } : {}),
      childThreadId: child.id,
      childTitle: child.title,
      kind: outcome,
      wakeReason: childWakeReason({ kind: outcome }),
      summary,
      ...(resultMessage ? { sourceMessageId: resultMessage.id } : {}),
    },
  };
}

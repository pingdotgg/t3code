import {
  type ChatAttachment,
  isCompactionCommandMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import { isSlashCommandText, modelSelectionsEqual } from "@t3tools/shared/model";
import { mergeQueuedMessages } from "@t3tools/shared/queuedMessageMerge";

import type { ThreadStructure } from "./models.ts";

type Projection = ThreadStructure;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
  /** Carries the attribution a sent message shows: automation, agent sender, or guest. */
  readonly message?: Message;
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canPromoteToSteer: boolean;
  /** The active run is a compaction, so promoting a queued message stops it instead of steering. */
  readonly promoteSkipsCompaction: boolean;
  readonly canSendNow: boolean;
  readonly sendAsOneBlockedReason: string | null;
  readonly sendEachBlockedReason: string | null;
}

const SEND_NOT_NOW_REASON = "The current turn can't take messages right now.";

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSupportsProviderHandoff(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;

  // Detaching a stopped session removes it from the projection, but its native
  // provider thread remains available for the next turn's portable handoff.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId &&
      thread.nativeThreadRef !== null,
  );
}

export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

export function deriveThreadQueueWorkflowState(projection: Projection): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const activeMessage = projection.messages.find(
    (message) => message.id === activeRun?.userMessageId,
  );
  const promoteSkipsCompaction =
    activeMessage !== undefined && isCompactionCommandMessage(activeMessage);
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      // A queued guest message shows the guest's words; the agent still gets the attributed text.
      text: message?.context?.guest?.text ?? message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
      ...(message ? { message } : {}),
    };
  });

  const canSendNow =
    activeRun === null &&
    projection.thread.archivedAt == null &&
    projection.thread.deletedAt == null;
  const canPromoteToSteer =
    promoteSkipsCompaction ||
    (hasSteerableProviderTurn &&
      (capabilities?.supportsActiveSteering === true ||
        capabilities?.supportsSteeringByInterruptRestart === true));
  const merged = mergeQueuedMessages(queuedRuns);

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canSendNow,
    canPromoteToSteer,
    promoteSkipsCompaction,
    sendAsOneBlockedReason:
      merged._tag === "Blocked"
        ? merged.reason
        : canSendNow || canPromoteToSteer
          ? null
          : SEND_NOT_NOW_REASON,
    sendEachBlockedReason: canSendNow
      ? null
      : resolveSteerEachBlockedReason({
          activeRun,
          queuedRuns,
          canPromoteToSteer,
          promoteSkipsCompaction,
          capabilities,
        }),
  };
}

/**
 * The server rejects a steer into a run that a previous steer restarted, so steering a whole
 * queue in a row only works when each message joins the running turn as it is.
 */
function resolveSteerEachBlockedReason(input: {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly canPromoteToSteer: boolean;
  readonly promoteSkipsCompaction: boolean;
  readonly capabilities: ProviderSession["capabilities"]["turns"] | undefined;
}): string | null {
  const { activeRun, capabilities } = input;
  if (!input.canPromoteToSteer || activeRun === null) return SEND_NOT_NOW_REASON;
  if (input.promoteSkipsCompaction) return "Send them as one to skip the compaction.";
  if (capabilities?.supportsActiveSteering !== true) {
    return "This agent restarts its turn for every message. Send them as one instead.";
  }
  const joinsRunningTurn = ({ run, message, attachments }: QueuedThreadRun) =>
    run.freshContext !== true &&
    !isSlashCommandText(message?.text ?? "") &&
    modelSelectionsEqual(run.modelSelection, activeRun.modelSelection) &&
    (attachments.length === 0 || capabilities.activeSteeringAcceptsAttachments !== false);
  return input.queuedRuns.every(joinsRunningTurn)
    ? null
    : "Some queued messages can't join the current turn.";
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  if (input.capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const capabilities = input.capabilities;
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}

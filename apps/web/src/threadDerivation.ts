import type { MessageId, OrchestrationQueuedTurn, ThreadId, TurnId } from "@t3tools/contracts";
import type { EnvironmentState } from "./store";
import type {
  ChatMessage,
  ProposedPlan,
  Thread,
  ThreadSession,
  ThreadShell,
  ThreadTurnState,
  TurnDiffSummary,
} from "./types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MESSAGE_IDS: MessageId[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_ACTIVITY_CONTEXT: NonNullable<Thread["activityContext"]> = [];
const EMPTY_INSIGHT_ACTIVITIES: NonNullable<Thread["insightActivities"]> = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];
const EMPTY_QUEUED_TURNS: readonly OrchestrationQueuedTurn[] = [];
const EMPTY_MESSAGE_MAP: Record<MessageId, ChatMessage> = {};
const EMPTY_ACTIVITY_MAP: Record<string, Thread["activities"][number]> = {};
const EMPTY_PROPOSED_PLAN_MAP: Record<string, ProposedPlan> = {};
const EMPTY_TURN_DIFF_MAP: Record<TurnId, TurnDiffSummary> = {};

const collectedByIdsCache = new WeakMap<readonly string[], WeakMap<object, readonly unknown[]>>();
const threadCache = new WeakMap<
  ThreadShell,
  {
    session: ThreadSession | null;
    turnState: ThreadTurnState | undefined;
    messages: Thread["messages"];
    activities: Thread["activities"];
    activityContext: NonNullable<Thread["activityContext"]>;
    hasMoreActivities: boolean;
    hasMoreCurrentTurnActivities: boolean;
    insightActivities: NonNullable<Thread["insightActivities"]>;
    proposedPlans: Thread["proposedPlans"];
    turnDiffSummaries: Thread["turnDiffSummaries"];
    queuedTurns: readonly OrchestrationQueuedTurn[];
    reviewState: NonNullable<EnvironmentState["reviewStateByThreadId"]>[ThreadId] | undefined;
    thread: Thread;
  }
>();

function threadPullRequestEqual(
  previous: ThreadShell["pullRequest"],
  next: ThreadShell["pullRequest"],
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }
  return (
    previous.number === next.number &&
    previous.title === next.title &&
    previous.url === next.url &&
    previous.baseBranch === next.baseBranch &&
    previous.headBranch === next.headBranch &&
    previous.state === next.state
  );
}

function threadShellContentEqualIgnoringUpdatedAt(
  previous: ThreadShell,
  next: ThreadShell,
): boolean {
  if (previous === next) {
    return true;
  }

  return (
    previous.id === next.id &&
    previous.environmentId === next.environmentId &&
    previous.codexThreadId === next.codexThreadId &&
    previous.projectId === next.projectId &&
    previous.parentThreadId === next.parentThreadId &&
    previous.title === next.title &&
    previous.modelSelection.instanceId === next.modelSelection.instanceId &&
    previous.modelSelection.model === next.modelSelection.model &&
    previous.runtimeMode === next.runtimeMode &&
    previous.pendingRuntimeMode === next.pendingRuntimeMode &&
    previous.interactionMode === next.interactionMode &&
    previous.error === next.error &&
    previous.createdAt === next.createdAt &&
    previous.archivedAt === next.archivedAt &&
    previous.settledOverride === next.settledOverride &&
    previous.settledAt === next.settledAt &&
    previous.snoozedUntil === next.snoozedUntil &&
    previous.snoozedAt === next.snoozedAt &&
    previous.branch === next.branch &&
    previous.worktreePath === next.worktreePath &&
    threadPullRequestEqual(previous.pullRequest, next.pullRequest)
  );
}

const threadCoreCache = new Map<
  ThreadId,
  {
    shell: ThreadShell;
    session: ThreadSession | null;
    turnState: ThreadTurnState | undefined;
    activities: Thread["activities"];
    activityContext: NonNullable<Thread["activityContext"]>;
    hasMoreActivities: boolean;
    hasMoreCurrentTurnActivities: boolean;
    insightActivities: NonNullable<Thread["insightActivities"]>;
    proposedPlans: Thread["proposedPlans"];
    turnDiffSummaries: Thread["turnDiffSummaries"];
    queuedTurns: readonly OrchestrationQueuedTurn[];
    reviewState: NonNullable<EnvironmentState["reviewStateByThreadId"]>[ThreadId] | undefined;
    thread: Thread;
  }
>();

function collectByIds<TKey extends string, TValue>(
  ids: readonly TKey[] | undefined,
  byId: Record<TKey, TValue> | undefined,
  emptyValue: TValue[],
): TValue[] {
  if (!ids || ids.length === 0 || !byId) {
    return emptyValue;
  }

  const cachedByRecord = collectedByIdsCache.get(ids);
  const cached = cachedByRecord?.get(byId);
  if (cached) {
    return cached as TValue[];
  }

  const nextValues = ids.flatMap((id) => {
    const value = byId[id];
    return value ? [value] : [];
  });
  const nextCachedByRecord = cachedByRecord ?? new WeakMap<object, readonly unknown[]>();
  nextCachedByRecord.set(byId, nextValues);
  if (!cachedByRecord) {
    collectedByIdsCache.set(ids, nextCachedByRecord);
  }
  return nextValues;
}

export function selectThreadMessages(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread["messages"] {
  return collectByIds(
    state.messageIdsByThreadId[threadId],
    state.messageByThreadId[threadId] ?? EMPTY_MESSAGE_MAP,
    EMPTY_MESSAGES,
  );
}

export function selectThreadMessageIds(
  state: EnvironmentState,
  threadId: ThreadId,
): readonly MessageId[] {
  return state.messageIdsByThreadId[threadId] ?? EMPTY_MESSAGE_IDS;
}

function selectThreadActivities(state: EnvironmentState, threadId: ThreadId): Thread["activities"] {
  return collectByIds(
    state.activityIdsByThreadId[threadId],
    state.activityByThreadId[threadId] ?? EMPTY_ACTIVITY_MAP,
    EMPTY_ACTIVITIES,
  );
}

function selectThreadProposedPlans(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread["proposedPlans"] {
  return collectByIds(
    state.proposedPlanIdsByThreadId[threadId],
    state.proposedPlanByThreadId[threadId] ?? EMPTY_PROPOSED_PLAN_MAP,
    EMPTY_PROPOSED_PLANS,
  );
}

function selectThreadTurnDiffSummaries(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread["turnDiffSummaries"] {
  return collectByIds(
    state.turnDiffIdsByThreadId[threadId],
    state.turnDiffSummaryByThreadId[threadId] ?? EMPTY_TURN_DIFF_MAP,
    EMPTY_TURN_DIFF_SUMMARIES,
  );
}

export function getThreadCoreFromEnvironmentState(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread | undefined {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return undefined;
  }

  const session = state.threadSessionById[threadId] ?? null;
  const turnState = state.threadTurnStateById[threadId];
  const activities = selectThreadActivities(state, threadId);
  const activityContext = state.activityContextByThreadId[threadId] ?? EMPTY_ACTIVITY_CONTEXT;
  const hasMoreActivities = state.hasMoreActivitiesByThreadId?.[threadId] ?? false;
  const hasMoreCurrentTurnActivities =
    state.hasMoreCurrentTurnActivitiesByThreadId?.[threadId] ?? false;
  const insightActivities = state.insightActivitiesByThreadId[threadId] ?? EMPTY_INSIGHT_ACTIVITIES;
  const proposedPlans = selectThreadProposedPlans(state, threadId);
  const turnDiffSummaries = selectThreadTurnDiffSummaries(state, threadId);
  const queuedTurns = state.queuedTurnsByThreadId[threadId] ?? EMPTY_QUEUED_TURNS;
  const reviewState = state.reviewStateByThreadId?.[threadId];
  const cached = threadCoreCache.get(threadId);

  if (
    cached &&
    threadShellContentEqualIgnoringUpdatedAt(cached.shell, shell) &&
    cached.session === session &&
    cached.turnState === turnState &&
    cached.activities === activities &&
    cached.activityContext === activityContext &&
    cached.hasMoreActivities === hasMoreActivities &&
    cached.hasMoreCurrentTurnActivities === hasMoreCurrentTurnActivities &&
    cached.insightActivities === insightActivities &&
    cached.proposedPlans === proposedPlans &&
    cached.turnDiffSummaries === turnDiffSummaries &&
    cached.queuedTurns === queuedTurns &&
    cached.reviewState === reviewState
  ) {
    return cached.thread;
  }

  const thread: Thread = {
    ...shell,
    session,
    latestTurn: turnState?.latestTurn ?? null,
    pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
    messages: EMPTY_MESSAGES,
    activities,
    activityContext,
    hasMoreActivities,
    hasMoreCurrentTurnActivities,
    insightActivities,
    proposedPlans,
    turnDiffSummaries,
    ...(queuedTurns.length > 0 ? { queuedTurns: [...queuedTurns] } : {}),
    ...reviewState,
  };

  threadCoreCache.set(threadId, {
    shell,
    session,
    turnState,
    activities,
    activityContext,
    hasMoreActivities,
    hasMoreCurrentTurnActivities,
    insightActivities,
    proposedPlans,
    turnDiffSummaries,
    queuedTurns,
    reviewState,
    thread,
  });

  return thread;
}

export function getThreadFromEnvironmentState(
  state: EnvironmentState,
  threadId: ThreadId,
): Thread | undefined {
  const shell = state.threadShellById[threadId];
  if (!shell) {
    return undefined;
  }

  const session = state.threadSessionById[threadId] ?? null;
  const turnState = state.threadTurnStateById[threadId];
  const messages = selectThreadMessages(state, threadId);
  const activities = selectThreadActivities(state, threadId);
  const activityContext = state.activityContextByThreadId[threadId] ?? EMPTY_ACTIVITY_CONTEXT;
  const hasMoreActivities = state.hasMoreActivitiesByThreadId?.[threadId] ?? false;
  const hasMoreCurrentTurnActivities =
    state.hasMoreCurrentTurnActivitiesByThreadId?.[threadId] ?? false;
  const insightActivities = state.insightActivitiesByThreadId[threadId] ?? EMPTY_INSIGHT_ACTIVITIES;
  const proposedPlans = selectThreadProposedPlans(state, threadId);
  const turnDiffSummaries = selectThreadTurnDiffSummaries(state, threadId);
  const queuedTurns = state.queuedTurnsByThreadId[threadId] ?? EMPTY_QUEUED_TURNS;
  const reviewState = state.reviewStateByThreadId?.[threadId];
  const cached = threadCache.get(shell);

  if (
    cached &&
    cached.session === session &&
    cached.turnState === turnState &&
    cached.messages === messages &&
    cached.activities === activities &&
    cached.activityContext === activityContext &&
    cached.hasMoreActivities === hasMoreActivities &&
    cached.hasMoreCurrentTurnActivities === hasMoreCurrentTurnActivities &&
    cached.insightActivities === insightActivities &&
    cached.proposedPlans === proposedPlans &&
    cached.turnDiffSummaries === turnDiffSummaries &&
    cached.queuedTurns === queuedTurns &&
    cached.reviewState === reviewState
  ) {
    return cached.thread;
  }

  const thread: Thread = {
    ...shell,
    session,
    latestTurn: turnState?.latestTurn ?? null,
    pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
    messages,
    activities,
    activityContext,
    hasMoreActivities,
    hasMoreCurrentTurnActivities,
    insightActivities,
    proposedPlans,
    turnDiffSummaries,
    ...(queuedTurns.length > 0 ? { queuedTurns: [...queuedTurns] } : {}),
    ...reviewState,
  };

  threadCache.set(shell, {
    session,
    turnState,
    messages,
    activities,
    activityContext,
    hasMoreActivities,
    hasMoreCurrentTurnActivities,
    insightActivities,
    proposedPlans,
    turnDiffSummaries,
    queuedTurns,
    reviewState,
    thread,
  });

  return thread;
}

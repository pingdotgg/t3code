import {
  type MessageId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import {
  type ChatMessage,
  type Project,
  type ProposedPlan,
  type SidebarThreadSummary,
  type Thread,
  type ThreadSession,
  type ThreadTurnState,
  type TurnDiffSummary,
} from "./types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];

function collectByIds<TKey extends string, TValue>(
  ids: readonly TKey[] | undefined,
  byId: Record<TKey, TValue> | undefined,
): TValue[] {
  if (!ids || ids.length === 0 || !byId) {
    return [];
  }

  return ids.flatMap((id) => {
    const value = byId[id];
    return value ? [value] : [];
  });
}

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

export function createSidebarThreadSummarySelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => SidebarThreadSummary | undefined {
  return (state) =>
    ref
      ? selectEnvironmentState(state, ref.environmentId).sidebarThreadSummaryById[ref.threadId]
      : undefined;
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousSession: ThreadSession | null | undefined;
  let previousTurnState: ThreadTurnState | undefined;
  let previousMessageIds: MessageId[] | undefined;
  let previousMessagesById: EnvironmentState["messageByThreadId"][ThreadId] | undefined;
  let previousActivityIds: string[] | undefined;
  let previousActivitiesById: EnvironmentState["activityByThreadId"][ThreadId] | undefined;
  let previousProposedPlanIds: string[] | undefined;
  let previousProposedPlansById: EnvironmentState["proposedPlanByThreadId"][ThreadId] | undefined;
  let previousTurnDiffIds: TurnId[] | undefined;
  let previousTurnDiffsById: EnvironmentState["turnDiffSummaryByThreadId"][ThreadId] | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const threadId = ref.threadId;
    const shell = environmentState.threadShellById[threadId];
    if (!shell) {
      return undefined;
    }

    const session = environmentState.threadSessionById[threadId] ?? null;
    const turnState = environmentState.threadTurnStateById[threadId];
    const messageIds = environmentState.messageIdsByThreadId[threadId];
    const messageById = environmentState.messageByThreadId[threadId];
    const activityIds = environmentState.activityIdsByThreadId[threadId];
    const activityById = environmentState.activityByThreadId[threadId];
    const proposedPlanIds = environmentState.proposedPlanIdsByThreadId[threadId];
    const proposedPlanById = environmentState.proposedPlanByThreadId[threadId];
    const turnDiffIds = environmentState.turnDiffIdsByThreadId[threadId];
    const turnDiffById = environmentState.turnDiffSummaryByThreadId[threadId];

    if (
      previousThread &&
      previousShell === shell &&
      previousSession === session &&
      previousTurnState === turnState &&
      previousMessageIds === messageIds &&
      previousMessagesById === messageById &&
      previousActivityIds === activityIds &&
      previousActivitiesById === activityById &&
      previousProposedPlanIds === proposedPlanIds &&
      previousProposedPlansById === proposedPlanById &&
      previousTurnDiffIds === turnDiffIds &&
      previousTurnDiffsById === turnDiffById
    ) {
      return previousThread;
    }

    const nextThread: Thread = {
      ...shell,
      session,
      latestTurn: turnState?.latestTurn ?? null,
      pendingSourceProposedPlan: turnState?.pendingSourceProposedPlan,
      messages: collectByIds(messageIds, messageById) as Thread["messages"] extends ChatMessage[]
        ? ChatMessage[]
        : never,
      activities: collectByIds(activityIds, activityById) as Thread["activities"] extends Array<
        infer _
      >
        ? Thread["activities"]
        : never,
      proposedPlans: collectByIds(
        proposedPlanIds,
        proposedPlanById,
      ) as Thread["proposedPlans"] extends ProposedPlan[] ? ProposedPlan[] : never,
      turnDiffSummaries: collectByIds(
        turnDiffIds,
        turnDiffById,
      ) as Thread["turnDiffSummaries"] extends TurnDiffSummary[] ? TurnDiffSummary[] : never,
    };

    previousShell = shell;
    previousSession = session;
    previousTurnState = turnState;
    previousMessageIds = messageIds;
    previousMessagesById = messageById;
    previousActivityIds = activityIds;
    previousActivitiesById = activityById;
    previousProposedPlanIds = proposedPlanIds;
    previousProposedPlansById = proposedPlanById;
    previousTurnDiffIds = turnDiffIds;
    previousTurnDiffsById = turnDiffById;
    previousThread = {
      ...nextThread,
      messages: nextThread.messages.length === 0 ? EMPTY_MESSAGES : nextThread.messages,
      activities: nextThread.activities.length === 0 ? EMPTY_ACTIVITIES : nextThread.activities,
      proposedPlans:
        nextThread.proposedPlans.length === 0 ? EMPTY_PROPOSED_PLANS : nextThread.proposedPlans,
      turnDiffSummaries:
        nextThread.turnDiffSummaries.length === 0
          ? EMPTY_TURN_DIFF_SUMMARIES
          : nextThread.turnDiffSummaries,
    };
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) {
      return undefined;
    }

    for (const [environmentId, environmentState] of Object.entries(
      state.environmentStateById,
    ) as Array<[ScopedThreadRef["environmentId"], EnvironmentState]>) {
      if (environmentState.threadShellById[threadId]) {
        return {
          environmentId,
          threadId,
        };
      }
    }
    return undefined;
  });
}

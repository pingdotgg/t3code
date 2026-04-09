import { type MessageId, type ProjectId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { type AppState } from "./store";
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

export function createProjectSelector(
  projectId: ProjectId | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) => (projectId ? state.projectById[projectId] : undefined);
}

export function createSidebarThreadSummarySelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => SidebarThreadSummary | undefined {
  return (state) => (threadId ? state.sidebarThreadSummaryById[threadId] : undefined);
}

export function createThreadSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousShell: AppState["threadShellById"][ThreadId] | undefined;
  let previousSession: ThreadSession | null | undefined;
  let previousTurnState: ThreadTurnState | undefined;
  let previousMessageIds: MessageId[] | undefined;
  let previousMessagesById: AppState["messageByThreadId"][ThreadId] | undefined;
  let previousActivityIds: string[] | undefined;
  let previousActivitiesById: AppState["activityByThreadId"][ThreadId] | undefined;
  let previousProposedPlanIds: string[] | undefined;
  let previousProposedPlansById: AppState["proposedPlanByThreadId"][ThreadId] | undefined;
  let previousTurnDiffIds: TurnId[] | undefined;
  let previousTurnDiffsById: AppState["turnDiffSummaryByThreadId"][ThreadId] | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    if (!threadId) {
      return undefined;
    }

    const shell = state.threadShellById[threadId];
    if (!shell) {
      return undefined;
    }

    const session = state.threadSessionById[threadId] ?? null;
    const turnState = state.threadTurnStateById[threadId];
    const messageIds = state.messageIdsByThreadId[threadId];
    const messageById = state.messageByThreadId[threadId];
    const activityIds = state.activityIdsByThreadId[threadId];
    const activityById = state.activityByThreadId[threadId];
    const proposedPlanIds = state.proposedPlanIdsByThreadId[threadId];
    const proposedPlanById = state.proposedPlanByThreadId[threadId];
    const turnDiffIds = state.turnDiffIdsByThreadId[threadId];
    const turnDiffById = state.turnDiffSummaryByThreadId[threadId];

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

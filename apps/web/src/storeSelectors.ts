import {
  type ApprovalRequestId,
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
  type ThreadShell,
  type ThreadSession,
  type ThreadTurnState,
  type TurnDiffSummary,
} from "./types";
import {
  type ActivePlanState,
  type LatestProposedPlanState,
  type PendingApproval,
  type PendingUserInput,
  type WorkLogEntry,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";
import { getThreadFromEnvironmentState } from "./threadDerivation";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MESSAGE_IDS: readonly MessageId[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];

export type ThreadStaticShellSnapshot = Pick<
  ThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "error"
  | "createdAt"
  | "branch"
  | "worktreePath"
>;

export interface ThreadRuntimeSnapshot {
  session: Pick<
    ThreadSession,
    "provider" | "status" | "activeTurnId" | "createdAt" | "updatedAt" | "orchestrationStatus"
  > | null;
  latestTurn: Pick<
    NonNullable<ThreadTurnState["latestTurn"]>,
    | "turnId"
    | "state"
    | "requestedAt"
    | "startedAt"
    | "completedAt"
    | "assistantMessageId"
    | "sourceProposedPlan"
  > | null;
  pendingSourceProposedPlan?: ThreadTurnState["pendingSourceProposedPlan"];
  phase: ReturnType<typeof derivePhase>;
}

export interface ThreadConversationRuntimeSnapshot {
  session: Pick<
    ThreadSession,
    "provider" | "status" | "activeTurnId" | "orchestrationStatus"
  > | null;
  latestTurn: Pick<
    NonNullable<ThreadTurnState["latestTurn"]>,
    | "turnId"
    | "state"
    | "requestedAt"
    | "startedAt"
    | "completedAt"
    | "assistantMessageId"
    | "sourceProposedPlan"
  > | null;
  phase: ReturnType<typeof derivePhase>;
}

export interface ThreadPendingSnapshot {
  pendingApprovalRequestId: ApprovalRequestId | null;
  pendingUserInputRequestId: ApprovalRequestId | null;
}

export interface ThreadComposerSnapshot {
  session: ThreadConversationRuntimeSnapshot["session"];
  latestTurn: ThreadConversationRuntimeSnapshot["latestTurn"];
  phase: ReturnType<typeof derivePhase>;
  latestTurnSettled: boolean;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activeProposedPlan: LatestProposedPlanState | null;
  activePlan: ActivePlanState | null;
}

export interface ThreadTimelineSliceSnapshot {
  historicalMessages: ChatMessage[];
  liveMessages: ChatMessage[];
  historicalProposedPlans: ProposedPlan[];
  liveProposedPlans: ProposedPlan[];
  turnDiffSummaries: TurnDiffSummary[];
  activeWorkEntries: WorkLogEntry[];
  latestTurnHasToolActivity: boolean;
}

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

function shallowArrayEqual<TValue>(
  left: ReadonlyArray<TValue>,
  right: ReadonlyArray<TValue>,
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeArrayResult<TValue>(values: TValue[], emptyValue: TValue[]): TValue[] {
  return values.length === 0 ? emptyValue : values;
}

function latestTurnSnapshotsEqual(
  left: ThreadConversationRuntimeSnapshot["latestTurn"],
  right: ThreadConversationRuntimeSnapshot["latestTurn"],
): boolean {
  return (
    left?.turnId === right?.turnId &&
    left?.state === right?.state &&
    left?.requestedAt === right?.requestedAt &&
    left?.startedAt === right?.startedAt &&
    left?.completedAt === right?.completedAt &&
    left?.assistantMessageId === right?.assistantMessageId &&
    left?.sourceProposedPlan === right?.sourceProposedPlan
  );
}

function conversationSessionSnapshotsEqual(
  left: ThreadConversationRuntimeSnapshot["session"],
  right: ThreadConversationRuntimeSnapshot["session"],
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.status === right?.status &&
    left?.activeTurnId === right?.activeTurnId &&
    left?.orchestrationStatus === right?.orchestrationStatus
  );
}

function runtimeSessionSnapshotsEqual(
  left: ThreadRuntimeSnapshot["session"],
  right: ThreadRuntimeSnapshot["session"],
): boolean {
  return (
    conversationSessionSnapshotsEqual(left, right) &&
    left?.createdAt === right?.createdAt &&
    left?.updatedAt === right?.updatedAt
  );
}

function toLatestTurnSnapshot(
  latestTurn: ThreadTurnState["latestTurn"],
): ThreadConversationRuntimeSnapshot["latestTurn"] {
  return latestTurn
    ? {
        turnId: latestTurn.turnId,
        state: latestTurn.state,
        requestedAt: latestTurn.requestedAt,
        startedAt: latestTurn.startedAt,
        completedAt: latestTurn.completedAt,
        assistantMessageId: latestTurn.assistantMessageId,
        sourceProposedPlan: latestTurn.sourceProposedPlan,
      }
    : null;
}

function toConversationSessionSnapshot(
  session: ThreadSession | null,
): ThreadConversationRuntimeSnapshot["session"] {
  return session
    ? {
        provider: session.provider,
        status: session.status,
        activeTurnId: session.activeTurnId,
        orchestrationStatus: session.orchestrationStatus,
      }
    : null;
}

function toRuntimeSessionSnapshot(session: ThreadSession | null): ThreadRuntimeSnapshot["session"] {
  return session
    ? {
        provider: session.provider,
        status: session.status,
        activeTurnId: session.activeTurnId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        orchestrationStatus: session.orchestrationStatus,
      }
    : null;
}

function resolveThreadState(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): {
  session: ThreadSession | null;
  turnState: ThreadTurnState | undefined;
} | null {
  if (!ref) {
    return null;
  }

  const environmentState = selectEnvironmentState(state, ref.environmentId);
  if (!environmentState.threadShellById[ref.threadId]) {
    return null;
  }

  return {
    session: environmentState.threadSessionById[ref.threadId] ?? null,
    turnState: environmentState.threadTurnStateById[ref.threadId],
  };
}

function pendingApprovalsEqual(
  left: ReadonlyArray<PendingApproval>,
  right: ReadonlyArray<PendingApproval>,
): boolean {
  return (
    left.length === right.length &&
    left.every((approval, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        approval.requestId === candidate.requestId &&
        approval.requestKind === candidate.requestKind &&
        approval.createdAt === candidate.createdAt &&
        approval.detail === candidate.detail
      );
    })
  );
}

function pendingUserInputsEqual(
  left: ReadonlyArray<PendingUserInput>,
  right: ReadonlyArray<PendingUserInput>,
): boolean {
  return (
    left.length === right.length &&
    left.every((userInput, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        userInput.requestId === candidate.requestId &&
        userInput.createdAt === candidate.createdAt &&
        shallowArrayEqual(userInput.questions, candidate.questions)
      );
    })
  );
}

function activePlanStatesEqual(
  left: ActivePlanState | null,
  right: ActivePlanState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.createdAt === right.createdAt &&
    left.turnId === right.turnId &&
    left.explanation === right.explanation &&
    left.steps.length === right.steps.length &&
    left.steps.every(
      (step, index) =>
        step.step === right.steps[index]?.step && step.status === right.steps[index]?.status,
    )
  );
}

function latestProposedPlansEqual(
  left: LatestProposedPlanState | null,
  right: LatestProposedPlanState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.turnId === right.turnId &&
    left.planMarkdown === right.planMarkdown &&
    left.implementedAt === right.implementedAt &&
    left.implementationThreadId === right.implementationThreadId
  );
}

function workLogEntriesEqual(
  left: ReadonlyArray<WorkLogEntry>,
  right: ReadonlyArray<WorkLogEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.createdAt === candidate.createdAt &&
        entry.label === candidate.label &&
        entry.tone === candidate.tone &&
        entry.detail === candidate.detail &&
        entry.command === candidate.command &&
        entry.rawCommand === candidate.rawCommand &&
        entry.toolTitle === candidate.toolTitle &&
        entry.itemType === candidate.itemType &&
        entry.requestKind === candidate.requestKind &&
        shallowArrayEqual(entry.changedFiles ?? [], candidate.changedFiles ?? [])
      );
    })
  );
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

export type ThreadBranchToolbarSnapshot = Pick<
  ThreadShell,
  "environmentId" | "projectId" | "worktreePath"
>;

export type ThreadWorkspaceSnapshot = ThreadBranchToolbarSnapshot;

export type ThreadBranchActionSnapshot = Pick<
  ThreadShell,
  "id" | "environmentId" | "projectId" | "branch" | "worktreePath"
> & {
  hasSession: boolean;
};

export function createThreadBranchToolbarSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadWorkspaceSnapshot | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousResult: ThreadWorkspaceSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    if (
      previousResult &&
      previousShell?.environmentId === shell.environmentId &&
      previousShell.projectId === shell.projectId &&
      previousShell.worktreePath === shell.worktreePath
    ) {
      previousShell = shell;
      return previousResult;
    }

    previousShell = shell;
    previousResult = {
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      worktreePath: shell.worktreePath,
    };
    return previousResult;
  };
}

export function createThreadBranchActionSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadBranchActionSnapshot | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousSession: ThreadSession | null | undefined;
  let previousResult: ThreadBranchActionSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousShell = undefined;
      previousSession = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousShell = undefined;
      previousSession = undefined;
      previousResult = undefined;
      return undefined;
    }

    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    const hasSession = session !== null;

    if (
      previousResult &&
      previousShell?.id === shell.id &&
      previousShell.environmentId === shell.environmentId &&
      previousShell.projectId === shell.projectId &&
      previousShell.branch === shell.branch &&
      previousShell.worktreePath === shell.worktreePath &&
      (previousSession !== null) === hasSession
    ) {
      previousShell = shell;
      previousSession = session;
      return previousResult;
    }

    previousShell = shell;
    previousSession = session;
    previousResult = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      hasSession,
    };
    return previousResult;
  };
}

export function createThreadStaticShellSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadStaticShellSnapshot | undefined {
  let previousShell: EnvironmentState["threadShellById"][ThreadId] | undefined;
  let previousResult: ThreadStaticShellSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousShell = undefined;
      previousResult = undefined;
      return undefined;
    }

    if (
      previousResult &&
      previousShell?.id === shell.id &&
      previousShell.environmentId === shell.environmentId &&
      previousShell.projectId === shell.projectId &&
      previousShell.title === shell.title &&
      previousShell.modelSelection === shell.modelSelection &&
      previousShell.runtimeMode === shell.runtimeMode &&
      previousShell.interactionMode === shell.interactionMode &&
      previousShell.error === shell.error &&
      previousShell.createdAt === shell.createdAt &&
      previousShell.branch === shell.branch &&
      previousShell.worktreePath === shell.worktreePath
    ) {
      previousShell = shell;
      return previousResult;
    }

    previousShell = shell;
    previousResult = {
      id: shell.id,
      environmentId: shell.environmentId,
      projectId: shell.projectId,
      title: shell.title,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      error: shell.error,
      createdAt: shell.createdAt,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
    };
    return previousResult;
  };
}

export function createThreadRuntimeSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadRuntimeSnapshot | undefined {
  let previousResult: ThreadRuntimeSnapshot | undefined;

  return (state) => {
    const resolved = resolveThreadState(state, ref);
    if (!resolved) {
      previousResult = undefined;
      return undefined;
    }

    const { session, turnState } = resolved;
    const nextSession = toRuntimeSessionSnapshot(session);
    const nextLatestTurn = toLatestTurnSnapshot(turnState?.latestTurn ?? null);
    const phase = derivePhase(session);
    const pendingSourceProposedPlan = turnState?.pendingSourceProposedPlan;

    if (
      previousResult &&
      runtimeSessionSnapshotsEqual(previousResult.session, nextSession) &&
      latestTurnSnapshotsEqual(previousResult.latestTurn, nextLatestTurn) &&
      previousResult.pendingSourceProposedPlan === pendingSourceProposedPlan &&
      previousResult.phase === phase
    ) {
      return previousResult;
    }

    previousResult = {
      session:
        previousResult && runtimeSessionSnapshotsEqual(previousResult.session, nextSession)
          ? previousResult.session
          : nextSession,
      latestTurn:
        previousResult && latestTurnSnapshotsEqual(previousResult.latestTurn, nextLatestTurn)
          ? previousResult.latestTurn
          : nextLatestTurn,
      pendingSourceProposedPlan,
      phase,
    };
    return previousResult;
  };
}

export function createThreadConversationRuntimeSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadConversationRuntimeSnapshot | undefined {
  let previousResult: ThreadConversationRuntimeSnapshot | undefined;

  return (state) => {
    const resolved = resolveThreadState(state, ref);
    if (!resolved) {
      previousResult = undefined;
      return undefined;
    }

    const { session, turnState } = resolved;
    const nextSession = toConversationSessionSnapshot(session);
    const nextLatestTurn = toLatestTurnSnapshot(turnState?.latestTurn ?? null);
    const phase = derivePhase(session);

    if (
      previousResult &&
      conversationSessionSnapshotsEqual(previousResult.session, nextSession) &&
      latestTurnSnapshotsEqual(previousResult.latestTurn, nextLatestTurn) &&
      previousResult.phase === phase
    ) {
      return previousResult;
    }

    previousResult = {
      session:
        previousResult && conversationSessionSnapshotsEqual(previousResult.session, nextSession)
          ? previousResult.session
          : nextSession,
      latestTurn:
        previousResult && latestTurnSnapshotsEqual(previousResult.latestTurn, nextLatestTurn)
          ? previousResult.latestTurn
          : nextLatestTurn,
      phase,
    };
    return previousResult;
  };
}

export function createThreadMessageIdsSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => readonly MessageId[] {
  let previousIds: readonly MessageId[] | undefined;
  let previousResult: readonly MessageId[] = EMPTY_MESSAGE_IDS;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousResult = EMPTY_MESSAGE_IDS;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const messageIds = environmentState.messageIdsByThreadId[ref.threadId];

    if (messageIds && messageIds.length > 0) {
      if (
        previousIds &&
        previousIds.length === messageIds.length &&
        previousIds.every((id, index) => id === messageIds[index])
      ) {
        return previousResult;
      }
      previousIds = messageIds;
      previousResult = messageIds;
      return previousResult;
    }

    previousIds = undefined;
    previousResult = EMPTY_MESSAGE_IDS;
    return previousResult;
  };
}

export function createThreadActivitiesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["activities"] {
  let previousIds: string[] | undefined;
  let previousActivitiesById: EnvironmentState["activityByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["activities"] = EMPTY_ACTIVITIES;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousActivitiesById = undefined;
      previousResult = EMPTY_ACTIVITIES;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const activityIds = environmentState.activityIdsByThreadId[ref.threadId];
    const activitiesById = environmentState.activityByThreadId[ref.threadId];

    if (previousIds === activityIds && previousActivitiesById === activitiesById) {
      return previousResult;
    }

    previousIds = activityIds;
    previousActivitiesById = activitiesById;
    const nextActivities = collectByIds(
      activityIds,
      activitiesById,
    ) as Thread["activities"] extends Array<infer _> ? Thread["activities"] : never;
    previousResult = normalizeArrayResult(nextActivities, EMPTY_ACTIVITIES);
    return previousResult;
  };
}

export function createThreadPendingSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadPendingSnapshot {
  let previousIds: string[] | undefined;
  let previousActivitiesById: EnvironmentState["activityByThreadId"][ThreadId] | undefined;
  let previousResult: ThreadPendingSnapshot = {
    pendingApprovalRequestId: null,
    pendingUserInputRequestId: null,
  };

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousActivitiesById = undefined;
      previousResult = {
        pendingApprovalRequestId: null,
        pendingUserInputRequestId: null,
      };
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const activityIds = environmentState.activityIdsByThreadId[ref.threadId];
    const activitiesById = environmentState.activityByThreadId[ref.threadId];

    if (previousIds === activityIds && previousActivitiesById === activitiesById) {
      return previousResult;
    }

    previousIds = activityIds;
    previousActivitiesById = activitiesById;
    const activities = collectByIds(
      activityIds,
      activitiesById,
    ) as Thread["activities"] extends infer TActivities ? TActivities : never;
    const pendingApprovalRequestId = derivePendingApprovals(activities)[0]?.requestId ?? null;
    const pendingUserInputRequestId = derivePendingUserInputs(activities)[0]?.requestId ?? null;

    if (
      previousResult.pendingApprovalRequestId === pendingApprovalRequestId &&
      previousResult.pendingUserInputRequestId === pendingUserInputRequestId
    ) {
      return previousResult;
    }

    previousResult = {
      pendingApprovalRequestId,
      pendingUserInputRequestId,
    };
    return previousResult;
  };
}

export function createThreadComposerSnapshotSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadComposerSnapshot | undefined {
  let previousResult: ThreadComposerSnapshot | undefined;

  return (state) => {
    if (!ref) {
      previousResult = undefined;
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousResult = undefined;
      return undefined;
    }

    const session = environmentState.threadSessionById[ref.threadId] ?? null;
    const latestTurn = environmentState.threadTurnStateById[ref.threadId]?.latestTurn ?? null;
    const activities = collectByIds(
      environmentState.activityIdsByThreadId[ref.threadId],
      environmentState.activityByThreadId[ref.threadId],
    ) as Thread["activities"] extends Array<infer _> ? Thread["activities"] : never;
    const proposedPlans = collectByIds(
      environmentState.proposedPlanIdsByThreadId[ref.threadId],
      environmentState.proposedPlanByThreadId[ref.threadId],
    ) as Thread["proposedPlans"] extends ProposedPlan[] ? ProposedPlan[] : never;

    const phase = derivePhase(session);
    const latestTurnSettled = isLatestTurnSettled(latestTurn, session);
    const pendingApprovals = derivePendingApprovals(activities);
    const pendingUserInputs = derivePendingUserInputs(activities);
    const activeProposedPlan = latestTurnSettled
      ? findLatestProposedPlan(proposedPlans, latestTurn?.turnId ?? null)
      : null;
    const activePlan = deriveActivePlanState(activities, latestTurn?.turnId ?? undefined);

    const nextSession = session
      ? {
          provider: session.provider,
          status: session.status,
          activeTurnId: session.activeTurnId,
          orchestrationStatus: session.orchestrationStatus,
        }
      : null;
    const nextLatestTurn = latestTurn
      ? {
          turnId: latestTurn.turnId,
          state: latestTurn.state,
          requestedAt: latestTurn.requestedAt,
          startedAt: latestTurn.startedAt,
          completedAt: latestTurn.completedAt,
          assistantMessageId: latestTurn.assistantMessageId,
          sourceProposedPlan: latestTurn.sourceProposedPlan,
        }
      : null;

    if (
      previousResult &&
      previousResult.session?.provider === nextSession?.provider &&
      previousResult.session?.status === nextSession?.status &&
      previousResult.session?.activeTurnId === nextSession?.activeTurnId &&
      previousResult.session?.orchestrationStatus === nextSession?.orchestrationStatus &&
      previousResult.latestTurn?.turnId === nextLatestTurn?.turnId &&
      previousResult.latestTurn?.state === nextLatestTurn?.state &&
      previousResult.latestTurn?.requestedAt === nextLatestTurn?.requestedAt &&
      previousResult.latestTurn?.startedAt === nextLatestTurn?.startedAt &&
      previousResult.latestTurn?.completedAt === nextLatestTurn?.completedAt &&
      previousResult.latestTurn?.assistantMessageId === nextLatestTurn?.assistantMessageId &&
      previousResult.latestTurn?.sourceProposedPlan === nextLatestTurn?.sourceProposedPlan &&
      previousResult.phase === phase &&
      previousResult.latestTurnSettled === latestTurnSettled &&
      pendingApprovalsEqual(previousResult.pendingApprovals, pendingApprovals) &&
      pendingUserInputsEqual(previousResult.pendingUserInputs, pendingUserInputs) &&
      activePlanStatesEqual(previousResult.activePlan, activePlan) &&
      latestProposedPlansEqual(previousResult.activeProposedPlan, activeProposedPlan)
    ) {
      return previousResult;
    }

    previousResult = {
      session:
        previousResult &&
        previousResult.session?.provider === nextSession?.provider &&
        previousResult.session?.status === nextSession?.status &&
        previousResult.session?.activeTurnId === nextSession?.activeTurnId &&
        previousResult.session?.orchestrationStatus === nextSession?.orchestrationStatus
          ? previousResult.session
          : nextSession,
      latestTurn:
        previousResult &&
        previousResult.latestTurn?.turnId === nextLatestTurn?.turnId &&
        previousResult.latestTurn?.state === nextLatestTurn?.state &&
        previousResult.latestTurn?.requestedAt === nextLatestTurn?.requestedAt &&
        previousResult.latestTurn?.startedAt === nextLatestTurn?.startedAt &&
        previousResult.latestTurn?.completedAt === nextLatestTurn?.completedAt &&
        previousResult.latestTurn?.assistantMessageId === nextLatestTurn?.assistantMessageId &&
        previousResult.latestTurn?.sourceProposedPlan === nextLatestTurn?.sourceProposedPlan
          ? previousResult.latestTurn
          : nextLatestTurn,
      phase,
      latestTurnSettled,
      pendingApprovals:
        previousResult && pendingApprovalsEqual(previousResult.pendingApprovals, pendingApprovals)
          ? previousResult.pendingApprovals
          : pendingApprovals,
      pendingUserInputs:
        previousResult &&
        pendingUserInputsEqual(previousResult.pendingUserInputs, pendingUserInputs)
          ? previousResult.pendingUserInputs
          : pendingUserInputs,
      activeProposedPlan:
        previousResult &&
        latestProposedPlansEqual(previousResult.activeProposedPlan, activeProposedPlan)
          ? previousResult.activeProposedPlan
          : activeProposedPlan,
      activePlan:
        previousResult && activePlanStatesEqual(previousResult.activePlan, activePlan)
          ? previousResult.activePlan
          : activePlan,
    };
    return previousResult;
  };
}

export function createThreadTimelineSliceSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => ThreadTimelineSliceSnapshot {
  let previousResult: ThreadTimelineSliceSnapshot = {
    historicalMessages: EMPTY_MESSAGES,
    liveMessages: EMPTY_MESSAGES,
    historicalProposedPlans: EMPTY_PROPOSED_PLANS,
    liveProposedPlans: EMPTY_PROPOSED_PLANS,
    turnDiffSummaries: EMPTY_TURN_DIFF_SUMMARIES,
    activeWorkEntries: [],
    latestTurnHasToolActivity: false,
  };

  return (state) => {
    if (!ref) {
      previousResult = {
        historicalMessages: EMPTY_MESSAGES,
        liveMessages: EMPTY_MESSAGES,
        historicalProposedPlans: EMPTY_PROPOSED_PLANS,
        liveProposedPlans: EMPTY_PROPOSED_PLANS,
        turnDiffSummaries: EMPTY_TURN_DIFF_SUMMARIES,
        activeWorkEntries: [],
        latestTurnHasToolActivity: false,
      };
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const shell = environmentState.threadShellById[ref.threadId];
    if (!shell) {
      previousResult = {
        historicalMessages: EMPTY_MESSAGES,
        liveMessages: EMPTY_MESSAGES,
        historicalProposedPlans: EMPTY_PROPOSED_PLANS,
        liveProposedPlans: EMPTY_PROPOSED_PLANS,
        turnDiffSummaries: EMPTY_TURN_DIFF_SUMMARIES,
        activeWorkEntries: [],
        latestTurnHasToolActivity: false,
      };
      return previousResult;
    }

    const messages = collectByIds(
      environmentState.messageIdsByThreadId[ref.threadId],
      environmentState.messageByThreadId[ref.threadId],
    ) as Thread["messages"] extends ChatMessage[] ? ChatMessage[] : never;
    const proposedPlans = collectByIds(
      environmentState.proposedPlanIdsByThreadId[ref.threadId],
      environmentState.proposedPlanByThreadId[ref.threadId],
    ) as Thread["proposedPlans"] extends ProposedPlan[] ? ProposedPlan[] : never;
    const turnDiffSummaries = collectByIds(
      environmentState.turnDiffIdsByThreadId[ref.threadId],
      environmentState.turnDiffSummaryByThreadId[ref.threadId],
    ) as Thread["turnDiffSummaries"] extends TurnDiffSummary[] ? TurnDiffSummary[] : never;
    const activities = collectByIds(
      environmentState.activityIdsByThreadId[ref.threadId],
      environmentState.activityByThreadId[ref.threadId],
    ) as Thread["activities"] extends Array<infer _> ? Thread["activities"] : never;
    const latestTurn = environmentState.threadTurnStateById[ref.threadId]?.latestTurn ?? null;
    const activeAssistantMessageId = latestTurn?.assistantMessageId ?? null;
    const activeTurnId = latestTurn?.turnId ?? undefined;
    const activeAssistantMessageIndex =
      activeAssistantMessageId === null
        ? -1
        : messages.findIndex((message) => message.id === activeAssistantMessageId);
    const activeAssistantMessageIsTail =
      activeAssistantMessageIndex >= 0 && activeAssistantMessageIndex === messages.length - 1;
    const shouldKeepActiveTurnContentLive = activeAssistantMessageIsTail;

    const historicalMessages = !shouldKeepActiveTurnContentLive
      ? messages
      : messages.filter((message) => message.id !== activeAssistantMessageId);
    const liveMessages = !shouldKeepActiveTurnContentLive
      ? EMPTY_MESSAGES
      : messages.filter((message) => message.id === activeAssistantMessageId);
    const historicalProposedPlans =
      activeTurnId === undefined || !shouldKeepActiveTurnContentLive
        ? proposedPlans
        : proposedPlans.filter((plan) => plan.turnId !== activeTurnId);
    const liveProposedPlans =
      activeTurnId === undefined || !shouldKeepActiveTurnContentLive
        ? EMPTY_PROPOSED_PLANS
        : proposedPlans.filter((plan) => plan.turnId === activeTurnId);
    const activeWorkEntries = deriveWorkLogEntries(activities, activeTurnId);
    const latestTurnHasToolActivity = hasToolActivityForTurn(activities, activeTurnId);

    const nextHistoricalMessages = shallowArrayEqual(
      previousResult.historicalMessages,
      historicalMessages,
    )
      ? previousResult.historicalMessages
      : historicalMessages.length === 0
        ? EMPTY_MESSAGES
        : historicalMessages;
    const nextLiveMessages = shallowArrayEqual(previousResult.liveMessages, liveMessages)
      ? previousResult.liveMessages
      : liveMessages.length === 0
        ? EMPTY_MESSAGES
        : liveMessages;
    const nextHistoricalProposedPlans = shallowArrayEqual(
      previousResult.historicalProposedPlans,
      historicalProposedPlans,
    )
      ? previousResult.historicalProposedPlans
      : historicalProposedPlans.length === 0
        ? EMPTY_PROPOSED_PLANS
        : historicalProposedPlans;
    const nextLiveProposedPlans = shallowArrayEqual(
      previousResult.liveProposedPlans,
      liveProposedPlans,
    )
      ? previousResult.liveProposedPlans
      : liveProposedPlans.length === 0
        ? EMPTY_PROPOSED_PLANS
        : liveProposedPlans;
    const nextTurnDiffSummaries = shallowArrayEqual(
      previousResult.turnDiffSummaries,
      turnDiffSummaries,
    )
      ? previousResult.turnDiffSummaries
      : turnDiffSummaries.length === 0
        ? EMPTY_TURN_DIFF_SUMMARIES
        : turnDiffSummaries;
    const nextActiveWorkEntries = workLogEntriesEqual(
      previousResult.activeWorkEntries,
      activeWorkEntries,
    )
      ? previousResult.activeWorkEntries
      : activeWorkEntries;

    if (
      previousResult.historicalMessages === nextHistoricalMessages &&
      previousResult.liveMessages === nextLiveMessages &&
      previousResult.historicalProposedPlans === nextHistoricalProposedPlans &&
      previousResult.liveProposedPlans === nextLiveProposedPlans &&
      previousResult.turnDiffSummaries === nextTurnDiffSummaries &&
      previousResult.activeWorkEntries === nextActiveWorkEntries &&
      previousResult.latestTurnHasToolActivity === latestTurnHasToolActivity
    ) {
      return previousResult;
    }

    previousResult = {
      historicalMessages: nextHistoricalMessages,
      liveMessages: nextLiveMessages,
      historicalProposedPlans: nextHistoricalProposedPlans,
      liveProposedPlans: nextLiveProposedPlans,
      turnDiffSummaries: nextTurnDiffSummaries,
      activeWorkEntries: nextActiveWorkEntries,
      latestTurnHasToolActivity,
    };
    return previousResult;
  };
}

export function createThreadProposedPlansSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["proposedPlans"] {
  let previousIds: string[] | undefined;
  let previousProposedPlansById: EnvironmentState["proposedPlanByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["proposedPlans"] = EMPTY_PROPOSED_PLANS;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousProposedPlansById = undefined;
      previousResult = EMPTY_PROPOSED_PLANS;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const proposedPlanIds = environmentState.proposedPlanIdsByThreadId[ref.threadId];
    const proposedPlansById = environmentState.proposedPlanByThreadId[ref.threadId];

    if (previousIds === proposedPlanIds && previousProposedPlansById === proposedPlansById) {
      return previousResult;
    }

    previousIds = proposedPlanIds;
    previousProposedPlansById = proposedPlansById;
    const nextProposedPlans = collectByIds(
      proposedPlanIds,
      proposedPlansById,
    ) as Thread["proposedPlans"] extends ProposedPlan[] ? ProposedPlan[] : never;
    previousResult = normalizeArrayResult(nextProposedPlans, EMPTY_PROPOSED_PLANS);
    return previousResult;
  };
}

export function createThreadTurnDiffSummariesSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread["turnDiffSummaries"] {
  let previousIds: TurnId[] | undefined;
  let previousTurnDiffsById: EnvironmentState["turnDiffSummaryByThreadId"][ThreadId] | undefined;
  let previousResult: Thread["turnDiffSummaries"] = EMPTY_TURN_DIFF_SUMMARIES;

  return (state) => {
    if (!ref) {
      previousIds = undefined;
      previousTurnDiffsById = undefined;
      previousResult = EMPTY_TURN_DIFF_SUMMARIES;
      return previousResult;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    const turnDiffIds = environmentState.turnDiffIdsByThreadId[ref.threadId];
    const turnDiffsById = environmentState.turnDiffSummaryByThreadId[ref.threadId];

    if (previousIds === turnDiffIds && previousTurnDiffsById === turnDiffsById) {
      return previousResult;
    }

    previousIds = turnDiffIds;
    previousTurnDiffsById = turnDiffsById;
    const nextTurnDiffSummaries = collectByIds(
      turnDiffIds,
      turnDiffsById,
    ) as Thread["turnDiffSummaries"] extends TurnDiffSummary[] ? TurnDiffSummary[] : never;
    previousResult = shallowArrayEqual(previousResult, nextTurnDiffSummaries)
      ? previousResult
      : normalizeArrayResult(nextTurnDiffSummaries, EMPTY_TURN_DIFF_SUMMARIES);
    return previousResult;
  };
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) {
      return undefined;
    }

    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }

    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
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

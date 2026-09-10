import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  AgentDashboardAgent,
  AgentDashboardFeedStatus,
  AgentDashboardFeedUpdate,
  AgentDashboardRepository,
  AgentDashboardResearchRecord,
  AgentDashboardResearchStatus,
  AgentDashboardSnapshot,
  AgentDashboardThread,
  AgentDashboardThreadState,
  AgentDashboardVcsStatus,
  AgentDashboardWorktree,
  IsoDateTime,
  OrchestrationLatestTurn,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsWorktreeEntry,
  VcsStatusLocalResult,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { ProjectionActivitySummary } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

type DashboardVcsStatus = VcsStatusResult | VcsStatusLocalResult;

export class AgentDashboardSnapshotReadError extends Schema.TaggedError<AgentDashboardSnapshotReadError>()(
  "AgentDashboardSnapshotReadError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardSnapshotReaders {
  readonly readStatus: (
    cwd: string,
  ) => Effect.Effect<DashboardVcsStatus, AgentDashboardSnapshotReadError>;
  readonly listRefs: (
    input: VcsListRefsInput,
  ) => Effect.Effect<VcsListRefsResult, AgentDashboardSnapshotReadError>;
}

export interface LoadAgentDashboardSnapshotInput {
  readonly shellSnapshot: OrchestrationShellSnapshot;
  /** Recent activity summaries, deliberately excluding activity payload bodies. */
  readonly activities?: ReadonlyArray<ProjectionActivitySummary>;
  readonly observedAt: IsoDateTime;
  readonly readers: AgentDashboardSnapshotReaders;
}

const DASHBOARD_FEED_LIMIT = 100;

const timestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareNewest = <A extends { readonly id: string; readonly at: string }>(
  left: A,
  right: A,
): number => timestampMs(right.at) - timestampMs(left.at) || right.id.localeCompare(left.id);

const sortNewest = <A extends { readonly id: string; readonly at: string }>(
  values: ReadonlyArray<A>,
): Array<A> => values.toSorted(compareNewest);

const repositoryRef = (projectId: OrchestrationShellSnapshot["projects"][number]["id"]) => ({
  projectId,
});

const threadRef = (thread: OrchestrationThreadShell) => ({
  projectId: thread.projectId,
  threadId: thread.id,
});

const unavailableVcsStatus = (): AgentDashboardVcsStatus => ({
  availability: "unavailable",
  isRepo: false,
  state: "unknown",
  branch: null,
  defaultBranch: null,
  isDefaultBranch: false,
  hasUpstream: null,
  aheadCount: null,
  behindCount: null,
  aheadOfDefaultCount: null,
});

const toDashboardVcsStatus = (
  status: DashboardVcsStatus | null,
  defaultBranch: string | null,
): AgentDashboardVcsStatus => {
  if (status === null) {
    return unavailableVcsStatus();
  }

  if (!status.isRepo) {
    return {
      ...unavailableVcsStatus(),
      availability: "not-a-repository",
    };
  }

  const remoteStatus = "hasUpstream" in status ? status : null;
  const isDefaultBranch =
    status.isDefaultRef ||
    (defaultBranch !== null && status.refName !== null && status.refName === defaultBranch);

  return {
    availability: "available",
    isRepo: true,
    state: status.hasWorkingTreeChanges ? "dirty" : "clean",
    branch: status.refName,
    defaultBranch: defaultBranch ?? (isDefaultBranch ? status.refName : null),
    isDefaultBranch,
    hasUpstream: remoteStatus?.hasUpstream ?? null,
    aheadCount: remoteStatus?.aheadCount ?? null,
    behindCount: remoteStatus?.behindCount ?? null,
    aheadOfDefaultCount: remoteStatus?.aheadOfDefaultCount ?? null,
  };
};

const defaultBranchFromRefs = (result: VcsListRefsResult): string | null => {
  const defaultRef = result.refs.find((ref) => ref.isDefault);
  if (!defaultRef) {
    return null;
  }
  if (!defaultRef.isRemote) {
    return defaultRef.name;
  }

  const remoteName = defaultRef.remoteName;
  if (remoteName !== undefined && defaultRef.name.startsWith(`${remoteName}/`)) {
    return defaultRef.name.slice(remoteName.length + 1);
  }

  const separator = defaultRef.name.indexOf("/");
  return separator >= 0 ? defaultRef.name.slice(separator + 1) : defaultRef.name;
};

const toDashboardAgent = (thread: OrchestrationThreadShell): AgentDashboardAgent | null => {
  if (thread.session === null) {
    return null;
  }

  return {
    providerName: thread.session.providerName,
    ...(thread.session.providerInstanceId !== undefined
      ? { providerInstanceId: thread.session.providerInstanceId }
      : {}),
    status: thread.session.status,
    activeTurnId: thread.session.activeTurnId,
    updatedAt: thread.session.updatedAt,
  };
};

const toDashboardThreadState = (thread: OrchestrationThreadShell): AgentDashboardThreadState => {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return "needs-input";
  }

  switch (thread.session?.status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
      return "ready";
    case "stopped":
    case "interrupted":
      return "paused";
    default:
      return "idle";
  }
};

const toDashboardThread = (thread: OrchestrationThreadShell): AgentDashboardThread => ({
  threadId: thread.id,
  title: thread.title,
  model: thread.modelSelection.model,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  agent: toDashboardAgent(thread),
  state: toDashboardThreadState(thread),
  latestTurn: thread.latestTurn,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  hasActionableProposedPlan: thread.hasActionableProposedPlan,
  updatedAt: thread.updatedAt,
});

const toRepository = (input: {
  readonly project: OrchestrationShellSnapshot["projects"][number];
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly worktrees: ReadonlyArray<VcsWorktreeEntry>;
  readonly vcs: AgentDashboardVcsStatus;
}): AgentDashboardRepository => {
  const rootThreads = input.threads
    .filter((thread) => thread.worktreePath === null)
    .map(toDashboardThread);
  const worktrees: Array<AgentDashboardWorktree> = input.worktrees
    .filter((worktree) => !worktree.isMain)
    .map((worktree) => ({
      path: worktree.path,
      branch: worktree.refName,
      threads: input.threads
        .filter((thread) => thread.worktreePath === worktree.path)
        .map(toDashboardThread)
        .toSorted(
          (left, right) =>
            timestampMs(right.updatedAt) - timestampMs(left.updatedAt) ||
            right.threadId.localeCompare(left.threadId),
        ),
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));

  return {
    projectId: input.project.id,
    title: input.project.title,
    workspaceRoot: input.project.workspaceRoot,
    repositoryIdentity: input.project.repositoryIdentity ?? null,
    vcs: input.vcs,
    threads: rootThreads.toSorted(
      (left, right) =>
        timestampMs(right.updatedAt) - timestampMs(left.updatedAt) ||
        right.threadId.localeCompare(left.threadId),
    ),
    worktrees,
  };
};

const feedStatusForSession = (
  status: NonNullable<OrchestrationThreadShell["session"]>["status"],
): AgentDashboardFeedStatus => {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
      return "ready";
    case "stopped":
    case "interrupted":
      return "paused";
    case "idle":
      return "info";
  }
};

const feedStatusForTurn = (turn: OrchestrationLatestTurn): AgentDashboardFeedStatus => {
  switch (turn.state) {
    case "running":
      return "running";
    case "error":
      return "error";
    case "completed":
      return "completed";
    case "interrupted":
      return "paused";
  }
};

const feedStatusForActivity = (
  activity: Pick<OrchestrationThreadActivity, "tone">,
): AgentDashboardFeedStatus => {
  switch (activity.tone) {
    case "approval":
      return "needs-input";
    case "error":
      return "error";
    case "tool":
      return "running";
    case "info":
      return "info";
  }
};

const buildThreadFeed = (input: {
  readonly projectId: OrchestrationShellSnapshot["projects"][number]["id"];
  readonly thread: OrchestrationThreadShell;
  readonly activities: ReadonlyArray<ProjectionActivitySummary>;
}): Array<AgentDashboardFeedUpdate> => {
  const repository = repositoryRef(input.projectId);
  const threadReference = threadRef(input.thread);
  const updates: Array<AgentDashboardFeedUpdate> = [];

  for (const activity of input.activities) {
    updates.push({
      id: `activity:${activity.id}`,
      kind: "activity",
      status: feedStatusForActivity(activity),
      summary: activity.summary,
      occurredAt: activity.createdAt,
      repository,
      thread: threadReference,
      activityId: activity.id,
      activityKind: activity.kind,
      turnId: activity.turnId,
    });
  }

  if (input.thread.session !== null) {
    const session = input.thread.session;
    updates.push({
      id: `session:${input.thread.id}:${session.updatedAt}`,
      kind: "session",
      status: feedStatusForSession(session.status),
      summary: `${session.providerName ?? "Agent"} session is ${session.status}`,
      occurredAt: session.updatedAt,
      repository,
      thread: threadReference,
      turnId: session.activeTurnId,
    });
  }

  if (input.thread.latestTurn !== null) {
    const turn = input.thread.latestTurn;
    const occurredAt = turn.completedAt ?? turn.startedAt ?? turn.requestedAt;
    updates.push({
      id: `turn:${turn.turnId}:${turn.state}`,
      kind: "turn",
      status: feedStatusForTurn(turn),
      summary: `Turn ${turn.state}`,
      occurredAt,
      repository,
      thread: threadReference,
      turnId: turn.turnId,
    });
  }

  if (input.thread.hasPendingApprovals || input.thread.hasPendingUserInput) {
    const pending = [
      input.thread.hasPendingApprovals ? "approval" : null,
      input.thread.hasPendingUserInput ? "user input" : null,
    ].filter((value): value is string => value !== null);
    updates.push({
      id: `attention:${input.thread.id}:${pending.join("+")}`,
      kind: "attention",
      status: "needs-input",
      summary: `Waiting for ${pending.join(" and ")}`,
      occurredAt: input.thread.updatedAt,
      repository,
      thread: threadReference,
      turnId: input.thread.session?.activeTurnId ?? null,
    });
  }

  return updates;
};

const buildFeed = (input: {
  readonly projects: ReadonlyArray<OrchestrationShellSnapshot["projects"][number]>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly activities: ReadonlyArray<ProjectionActivitySummary> | undefined;
}): Array<AgentDashboardFeedUpdate> => {
  const activitiesByThread = new Map<string, Array<ProjectionActivitySummary>>();
  for (const activity of input.activities ?? []) {
    const threadActivities = activitiesByThread.get(activity.threadId) ?? [];
    threadActivities.push(activity);
    activitiesByThread.set(activity.threadId, threadActivities);
  }
  const projectIds = new Set(input.projects.map((project) => project.id));
  const updates = input.threads
    .filter((thread) => projectIds.has(thread.projectId))
    .flatMap((thread) =>
      buildThreadFeed({
        projectId: thread.projectId,
        thread,
        activities: activitiesByThread.get(thread.id) ?? [],
      }),
    );

  return sortNewest(updates.map((update) => ({ ...update, at: update.occurredAt })))
    .slice(0, DASHBOARD_FEED_LIMIT)
    .map(({ at: _at, ...update }) => update);
};

const researchStatusForVcs = (vcs: AgentDashboardVcsStatus): AgentDashboardResearchStatus => {
  if (vcs.availability === "unavailable") {
    return "unavailable";
  }
  if (!vcs.isRepo || vcs.availability === "not-a-repository") {
    return "not-a-repository";
  }
  if (vcs.state === "dirty") {
    return "dirty";
  }

  const ahead = vcs.aheadOfDefaultCount ?? vcs.aheadCount ?? 0;
  const behind = vcs.behindCount ?? 0;
  if (ahead > 0 && behind > 0) {
    return "diverged";
  }
  if (behind > 0) {
    return "behind";
  }
  if (ahead > 0 && !vcs.isDefaultBranch) {
    return "ahead";
  }
  return "clean";
};

const researchSummaryForVcs = (vcs: AgentDashboardVcsStatus): string => {
  if (vcs.availability === "unavailable") {
    return "VCS status is unavailable";
  }
  if (!vcs.isRepo || vcs.availability === "not-a-repository") {
    return "Git is not initialized for this project";
  }
  if (vcs.state === "dirty") {
    return "Working tree has local changes";
  }
  if ((vcs.behindCount ?? 0) > 0 && (vcs.aheadOfDefaultCount ?? vcs.aheadCount ?? 0) > 0) {
    return "Branch has local commits and is behind its default branch";
  }
  if ((vcs.behindCount ?? 0) > 0) {
    return "Branch is behind its upstream";
  }
  if ((vcs.aheadOfDefaultCount ?? vcs.aheadCount ?? 0) > 0 && !vcs.isDefaultBranch) {
    return "Branch has commits ahead of its default branch";
  }
  return "Working tree is clean";
};

const toResearchRecord = (input: {
  readonly repository: AgentDashboardRepository;
  readonly observedAt: IsoDateTime;
}): AgentDashboardResearchRecord => {
  const threads = [
    ...input.repository.threads,
    ...input.repository.worktrees.flatMap((worktree) => worktree.threads),
  ];
  const latestThread = threads.toSorted(
    (left, right) =>
      timestampMs(right.updatedAt) - timestampMs(left.updatedAt) ||
      right.threadId.localeCompare(left.threadId),
  )[0];
  const repositoryName =
    input.repository.repositoryIdentity?.displayName?.trim() ||
    input.repository.repositoryIdentity?.name?.trim() ||
    input.repository.title;

  return {
    id: `repository:${input.repository.projectId}`,
    kind: "repository",
    status: researchStatusForVcs(input.repository.vcs),
    title: repositoryName,
    summary: researchSummaryForVcs(input.repository.vcs),
    observedAt: input.observedAt,
    repository: repositoryRef(input.repository.projectId),
    branch: input.repository.vcs.branch,
    defaultBranch: input.repository.vcs.defaultBranch,
    worktreePath: null,
    threadCount: threads.length,
    activeThreadCount: threads.filter(
      (thread) =>
        thread.state === "running" ||
        thread.agent?.status === "starting" ||
        thread.agent?.status === "running",
    ).length,
    latestThread:
      latestThread === undefined
        ? null
        : {
            projectId: input.repository.projectId,
            threadId: latestThread.threadId,
          },
  };
};

/**
 * Load the dashboard's read model from T3's active project/thread shell and
 * VCS primitives. The only paths read are projected project roots; registered
 * worktrees come from Git's shared repository metadata.
 */
export const loadAgentDashboardSnapshot = Effect.fn("loadAgentDashboardSnapshot")(function* (
  input: LoadAgentDashboardSnapshotInput,
) {
  const projectRoots = [
    ...new Set(input.shellSnapshot.projects.map((project) => project.workspaceRoot)),
  ];

  const statusEntries = yield* Effect.forEach(
    projectRoots,
    (cwd) =>
      input.readers.readStatus(cwd).pipe(
        Effect.map((status) => [cwd, status] as const),
        Effect.orElseSucceed(() => [cwd, null] as const),
      ),
    { concurrency: 4 },
  );
  const statuses = new Map(statusEntries);

  const refsEntries = yield* Effect.forEach(
    projectRoots,
    (cwd) =>
      input.readers
        .listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          limit: 200,
        })
        .pipe(
          Effect.map((result) => [cwd, result] as const),
          Effect.orElseSucceed(() => [cwd, null] as const),
        ),
    { concurrency: 4 },
  );
  const refsByRoot = new Map(refsEntries);

  const repositories = input.shellSnapshot.projects.map((project) => {
    const projectThreads = input.shellSnapshot.threads.filter(
      (thread) => thread.projectId === project.id,
    );
    const rootStatus = statuses.get(project.workspaceRoot) ?? null;
    const refs = refsByRoot.get(project.workspaceRoot) ?? null;
    const defaultBranch = refs === null ? null : defaultBranchFromRefs(refs);

    return toRepository({
      project,
      threads: projectThreads,
      worktrees: refs?.worktrees ?? [],
      vcs: toDashboardVcsStatus(rootStatus, defaultBranch),
    });
  });

  const feed = buildFeed({
    projects: input.shellSnapshot.projects,
    threads: input.shellSnapshot.threads,
    activities: input.activities,
  });
  const research = repositories
    .map((repository) => toResearchRecord({ repository, observedAt: input.observedAt }))
    .toSorted(
      (left, right) =>
        timestampMs(right.observedAt) - timestampMs(left.observedAt) ||
        right.id.localeCompare(left.id),
    );
  return {
    snapshotSequence: input.shellSnapshot.snapshotSequence,
    observedAt: input.observedAt,
    repositories,
    feed,
    research,
    // Native VCS/thread navigation belongs to Overview and Feed. Suggestions
    // is owned exclusively by durable review-run records joined below by the
    // websocket layer.
    suggestions: [],
    externalFeed: [],
    researchFindings: [],
    reviewSuggestions: [],
    automationRuns: [],
    findings: [],
    repositoryPolicies: [],
    repositoryCoverage: [],
    externalActions: [],
    collectorStates: [],
  } satisfies AgentDashboardSnapshot;
});

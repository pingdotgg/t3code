import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  T3HostVscodeWorkspaceBootstrap,
  ThreadId,
} from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "./scoped.ts";

export type VscodeProjectScope = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId?: ProjectId | null | undefined;
  readonly projectIds?: readonly ProjectId[] | null | undefined;
  readonly activeProjectId?: ProjectId | null | undefined;
  readonly cwd?: string | null | undefined;
  readonly cwds?: readonly string[] | null | undefined;
};

export type VscodeBootstrapProject = {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly isActive?: boolean;
};

export function resolveVscodeProjectScope(input: {
  readonly serverWelcome:
    | {
        readonly environment: { readonly environmentId: EnvironmentId };
        readonly bootstrapProjectId?: ProjectId | null | undefined;
        readonly bootstrapProjects?: readonly VscodeBootstrapProject[] | null | undefined;
        readonly cwd?: string | null | undefined;
      }
    | null
    | undefined;
  readonly serverConfig:
    | {
        readonly environment: { readonly environmentId: EnvironmentId };
        readonly cwd?: string | null | undefined;
      }
    | null
    | undefined;
  readonly vscodeWorkspaceBootstrap?: T3HostVscodeWorkspaceBootstrap | null | undefined;
  readonly fallbackEnvironmentId?: EnvironmentId | null | undefined;
}): VscodeProjectScope {
  const bootstrapProjects = input.serverWelcome?.bootstrapProjects ?? null;
  const vscodeBootstrapProjects = input.vscodeWorkspaceBootstrap?.bootstrapProjects ?? null;
  const bootstrapProjectId = input.serverWelcome?.bootstrapProjectId ?? null;
  const firstVscodeProjectId = vscodeBootstrapProjects?.[0]?.projectId;
  const activeBootstrapProjectId =
    bootstrapProjects?.find((project) => project.isActive)?.projectId ??
    vscodeBootstrapProjects?.find((project) => project.isActive)?.projectId ??
    bootstrapProjectId ??
    firstVscodeProjectId;

  return {
    environmentId:
      input.serverWelcome?.environment.environmentId ??
      input.serverConfig?.environment.environmentId ??
      input.vscodeWorkspaceBootstrap?.environmentId ??
      input.fallbackEnvironmentId ??
      null,
    projectId: bootstrapProjectId ?? firstVscodeProjectId ?? null,
    projectIds:
      bootstrapProjects?.map((project) => project.projectId) ??
      vscodeBootstrapProjects?.map((project) => project.projectId) ??
      null,
    activeProjectId: activeBootstrapProjectId,
    cwd: input.serverConfig?.cwd ?? input.serverWelcome?.cwd ?? null,
    cwds:
      bootstrapProjects?.map((project) => project.cwd) ??
      vscodeBootstrapProjects?.map((project) => project.cwd) ??
      null,
  };
}

export function filterProjectsForVscodeScope<
  TProject extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot?: string;
    readonly cwd?: string;
  },
>(projects: readonly TProject[], scope: VscodeProjectScope): TProject[] {
  if (!scope.environmentId) {
    return [];
  }

  return projects.filter((project) => {
    const projectCwd = project.workspaceRoot ?? project.cwd ?? null;
    if (project.environmentId !== scope.environmentId) {
      return false;
    }
    if (scope.projectIds && scope.projectIds.length > 0) {
      return scope.projectIds.includes(project.id);
    }
    if (scope.projectId) {
      return project.id === scope.projectId;
    }
    if (scope.cwds && scope.cwds.length > 0) {
      return projectCwd !== null && scope.cwds.includes(projectCwd);
    }
    return Boolean(scope.cwd) && projectCwd === scope.cwd;
  });
}

export type VscodeInitialThreadCandidate = {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
};

function toSortableTimestamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function getLatestUserMessageTimestamp(thread: VscodeInitialThreadCandidate): number {
  if (thread.latestUserMessageAt) {
    return toSortableTimestamp(thread.latestUserMessageAt) ?? Number.NEGATIVE_INFINITY;
  }

  let latestUserMessageTimestamp: number | null = null;
  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  return (
    latestUserMessageTimestamp ??
    getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

/**
 * Chooses the startup thread for a VS Code webview after the backend projects are known.
 * Selection is constrained to the bootstrapped workspace scope, prefers the active
 * workspace folder, then uses last-visited and thread recency as tie-breakers.
 */
export function resolveVscodeInitialThreadRef(input: {
  readonly threads: readonly VscodeInitialThreadCandidate[];
  readonly threadLastVisitedAtById: Readonly<Record<string, string>>;
  readonly scope: VscodeProjectScope;
}): ScopedThreadRef | null {
  if (!input.scope.environmentId) {
    return null;
  }
  const scopedProjectIds =
    input.scope.projectIds && input.scope.projectIds.length > 0
      ? input.scope.projectIds
      : input.scope.projectId
        ? [input.scope.projectId]
        : [];
  if (scopedProjectIds.length === 0) {
    return null;
  }

  const allCandidates = input.threads.filter(
    (thread) =>
      thread.environmentId === input.scope.environmentId &&
      scopedProjectIds.includes(thread.projectId) &&
      thread.archivedAt === null,
  );
  const activeProjectId = input.scope.activeProjectId ?? input.scope.projectId ?? null;
  const activeCandidates = activeProjectId
    ? allCandidates.filter((thread) => thread.projectId === activeProjectId)
    : [];
  const candidates = activeCandidates.length > 0 ? activeCandidates : allCandidates;
  if (candidates.length === 0) {
    return null;
  }

  const sorted = candidates.toSorted((left, right) => {
    if (activeProjectId && left.projectId !== right.projectId) {
      if (left.projectId === activeProjectId) {
        return -1;
      }
      if (right.projectId === activeProjectId) {
        return 1;
      }
    }

    const leftVisitedAt =
      toSortableTimestamp(
        input.threadLastVisitedAtById[scopedThreadKey(scopeThreadRef(left.environmentId, left.id))],
      ) ?? Number.NEGATIVE_INFINITY;
    const rightVisitedAt =
      toSortableTimestamp(
        input.threadLastVisitedAtById[
          scopedThreadKey(scopeThreadRef(right.environmentId, right.id))
        ],
      ) ?? Number.NEGATIVE_INFINITY;
    if (leftVisitedAt !== rightVisitedAt) {
      return rightVisitedAt - leftVisitedAt;
    }

    const rightTimestamp = getLatestUserMessageTimestamp(right);
    const leftTimestamp = getLatestUserMessageTimestamp(left);
    if (rightTimestamp !== leftTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return right.id.localeCompare(left.id);
  });
  const thread = sorted[0];
  return thread ? scopeThreadRef(thread.environmentId, thread.id) : null;
}

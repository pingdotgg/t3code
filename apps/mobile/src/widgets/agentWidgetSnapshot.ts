import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { DirectWidgetUpdate } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  projectThreadAwarenessV2,
  selectWidgetActivities,
  type AgentAwarenessState,
} from "@t3tools/shared/agentAwareness";

export interface AgentWidgetCopy {
  readonly caughtUp: string;
  readonly recent: string;
  readonly reviewError: string;
  readonly respond: string;
  readonly connectAgent: string;
  readonly moreActive: string;
  readonly tapReview: string;
  readonly tapOpen: string;
  readonly needsAttention: string;
  readonly connectOverview: string;
  readonly delayed: string;
  readonly moreThreads: string;
  readonly workOverview: string;
}

export interface AgentWidgetSnapshot {
  readonly copy?: AgentWidgetCopy;
  readonly appScheme?: string;
  readonly activeCount: number;
  readonly attentionCount: number;
  readonly activities: readonly AgentAwarenessState[];
  readonly updatedAt: string | null;
  /** Last resolved bitmap per `environmentId:projectId`; see `carryProjectIcons`. */
  readonly projectIcons?: Readonly<Record<string, string>>;
  readonly environments?: readonly {
    readonly environmentId: string;
    readonly snapshot: AgentWidgetSnapshot;
  }[];
}

function priority(phase: AgentAwarenessState["phase"]): number {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return 0;
    case "running":
    case "starting":
      return 1;
    case "failed":
      return 2;
    default:
      return 3;
  }
}

/** Uses the same phase projection as server-side activity publishing. */
export function buildAgentWidgetSnapshot(input: {
  readonly projects: readonly Pick<EnvironmentProject, "id" | "environmentId" | "title">[];
  readonly threads: readonly Pick<
    EnvironmentThreadShell,
    "projectId" | "environmentId" | "archivedAt" | "source" | "runtime"
  >[];
  readonly now?: number;
}): AgentWidgetSnapshot {
  const projects = new Map(
    input.projects.map((project) => [
      scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      project,
    ]),
  );
  const activities: AgentAwarenessState[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const project = projects.get(
      scopedProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
    );
    if (!project) continue;
    const activity = projectThreadAwarenessV2({
      environmentId: thread.environmentId,
      project,
      thread: thread.source,
    });
    if (activity) {
      activities.push(
        activity.phase === "failed" && thread.runtime?.lastError
          ? { ...activity, detail: thread.runtime.lastError }
          : activity,
      );
    }
  }
  const selected = selectWidgetActivities(activities, input.now ?? Date.now());
  const visible = selected.slice(0, 5);
  const environmentIds = [...new Set(input.projects.map((project) => project.environmentId))];
  return {
    activeCount: activities.filter((activity) => priority(activity.phase) < 2).length,
    attentionCount: activities.filter((activity) => priority(activity.phase) === 0).length,
    activities: visible,
    updatedAt: visible.reduce<string | null>(
      (latest, activity) =>
        latest === null || activity.updatedAt > latest ? activity.updatedAt : latest,
      null,
    ),
    ...(environmentIds.length
      ? {
          environments: environmentIds.map((environmentId) => {
            const rows = selected.filter((activity) => activity.environmentId === environmentId);
            return {
              environmentId,
              snapshot: {
                activeCount: rows.filter((activity) => priority(activity.phase) < 2).length,
                attentionCount: rows.filter((activity) => priority(activity.phase) === 0).length,
                activities: rows.slice(0, 5),
                updatedAt: rows.reduce<string | null>(
                  (latest, row) =>
                    latest === null || row.updatedAt > latest ? row.updatedAt : latest,
                  null,
                ),
              },
            };
          }),
        }
      : {}),
  };
}

/** Transcript timestamps alone must not spend the widget's reload budget. */
export function agentWidgetContentKey(snapshot: AgentWidgetSnapshot): string {
  return JSON.stringify({
    activeCount: snapshot.activeCount,
    attentionCount: snapshot.attentionCount,
    activities: snapshot.activities.map(({ updatedAt: _updatedAt, ...activity }) => activity),
    environments: snapshot.environments?.map(({ environmentId, snapshot }) => ({
      environmentId,
      key: agentWidgetContentKey(snapshot),
    })),
  });
}

/** Replaces one server's snapshot and preserves other paired environments. */
export const EMPTY_AGENT_WIDGET_SNAPSHOT: AgentWidgetSnapshot = {
  activeCount: 0,
  attentionCount: 0,
  activities: [],
  updatedAt: null,
};

export function mergeWidgetUpdate(
  snapshot: AgentWidgetSnapshot,
  update: DirectWidgetUpdate,
): AgentWidgetSnapshot {
  const environments = snapshot.environments ?? [];
  const previous = environments.find((entry) => entry.environmentId === update.environmentId);
  if (
    previous !== undefined &&
    previous.snapshot.updatedAt !== null &&
    previous.snapshot.updatedAt >= update.activity.updatedAt
  )
    return snapshot;
  const replacement = {
    environmentId: update.environmentId,
    snapshot: {
      activeCount: update.activity.activeCount,
      attentionCount: update.attentionCount,
      updatedAt: update.activity.updatedAt,
      activities: update.activity.activities.map(({ status, ...row }) => ({
        ...row,
        headline: status,
      })),
    },
  };
  // A server the widget has never heard of (the app last wrote before its
  // projects hydrated, or the widget was seeded from a push) still gets a
  // row; dropping the push here used to leave the widget frozen for good.
  const next =
    previous === undefined
      ? [...environments, replacement]
      : environments.map((entry) =>
          entry.environmentId !== update.environmentId ? entry : replacement,
        );

  const activities = next
    .flatMap((entry) => entry.snapshot.activities)
    .sort((a, b) => priority(a.phase) - priority(b.phase) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  return {
    activeCount: next.reduce((sum, entry) => sum + entry.snapshot.activeCount, 0),
    attentionCount: next.reduce((sum, entry) => sum + entry.snapshot.attentionCount, 0),
    activities,
    updatedAt: update.activity.updatedAt,
    environments: next,
  };
}

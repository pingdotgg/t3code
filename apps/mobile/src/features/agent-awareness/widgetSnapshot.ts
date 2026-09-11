import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";

import type { AgentActivityRowProps } from "../../widgets/AgentActivity";
import type { AgentActivityWidgetProps } from "../../widgets/AgentActivityWidget";

export function connectedWidgetActivities(
  states: ReadonlyMap<EnvironmentId, EnvironmentShellState>,
): ReadonlyMap<string, ReadonlyArray<AgentActivityRowProps>> {
  const environments = new Map<string, ReadonlyArray<AgentActivityRowProps>>();
  for (const [environmentId, state] of states) {
    if (Option.isNone(state.snapshot)) continue;
    const snapshot = state.snapshot.value;
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const rows: Array<AgentActivityRowProps> = [];
    for (const thread of snapshot.threads) {
      const project = projects.get(thread.projectId);
      if (!project || thread.archivedAt !== null) continue;
      const activity = projectThreadAwareness({ environmentId, project, thread });
      if (!activity || activity.phase === "completed" || activity.phase === "failed") continue;
      const live = state.status === "live";
      rows.push({
        environmentId,
        threadId: thread.id,
        projectTitle: activity.projectTitle,
        threadTitle: activity.threadTitle,
        modelTitle: activity.modelTitle,
        phase: live ? activity.phase : "stale",
        status: live ? activity.headline : "Update delayed",
        updatedAt: activity.updatedAt,
        deepLink: activity.deepLink,
      });
    }
    // An authoritative empty snapshot also overrides older relay rows.
    environments.set(environmentId, rows);
  }
  return environments;
}

export function mergeWidgetActivities(
  relay: AgentActivityWidgetProps,
  connected: ReadonlyMap<string, ReadonlyArray<AgentActivityRowProps>>,
): AgentActivityWidgetProps {
  if (connected.size === 0) return relay;
  const activities = [
    ...(relay.activities ?? []).filter((row) => !connected.has(row.environmentId)),
    ...Array.from(connected.values()).flat(),
  ];
  const isActive = (row: AgentActivityRowProps) =>
    row.phase !== "stale" && row.phase !== "completed" && row.phase !== "failed";
  // A relay aggregate may omit rows. Its total cannot be deduplicated against
  // connected environments without knowing which environments those rows belong to.
  const relayHasHiddenRows =
    relay.activeCount === null ||
    (relay.activeCount ?? 0) > (relay.activities ?? []).filter(isActive).length;
  if (activities.length === 0 && !relayHasHiddenRows) return {};
  return {
    title: "T3 Code",
    subtitle: "Agent activity",
    activeCount: relayHasHiddenRows ? null : activities.filter(isActive).length,
    updatedAt: activities.reduce(
      (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
      relay.updatedAt ?? "",
    ),
    activities,
  };
}

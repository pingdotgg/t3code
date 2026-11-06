import {
  enabledEnvironmentIds,
  type EnvironmentCatalogState,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayAgentActivitySnapshotResponse } from "@t3tools/contracts/relay";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import type { AgentActivityRowProps } from "../../widgets/AgentActivity";

export type LiveWidgetActivities = ReadonlyMap<EnvironmentId, ReadonlyArray<AgentActivityRowProps>>;

const MAX_WIDGET_ROWS = 5;

const statusByPhase = {
  starting: "Connecting",
  running: "Working",
  waiting_for_approval: "Approval",
  waiting_for_input: "Input",
  completed: "Done",
  failed: "Failed",
  stale: "Waiting",
} satisfies Record<AgentActivityRowProps["phase"], string>;

function isActive(row: AgentActivityRowProps): boolean {
  return row.phase !== "completed" && row.phase !== "failed";
}

/** A live empty shell still owns its environment and suppresses older relay rows. */
export function createLiveWidgetActivitiesAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly now: () => number;
}) {
  return Atom.make((get): LiveWidgetActivities => {
    const environments = new Map<EnvironmentId, ReadonlyArray<AgentActivityRowProps>>();
    const now = input.now();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
      const snapshot = shell.snapshot.value;
      const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
      const rows: AgentActivityRowProps[] = [];
      for (const thread of snapshot.threads) {
        const project = projects.get(thread.projectId);
        if (!project) continue;
        const state = projectThreadAwarenessV2({ environmentId, project, thread, now });
        if (!state) continue;
        rows.push({
          environmentId,
          threadId: state.threadId,
          projectTitle: state.projectTitle,
          threadTitle: state.threadTitle,
          modelTitle: state.modelTitle,
          phase: state.phase,
          status: statusByPhase[state.phase],
          updatedAt: state.updatedAt,
          deepLink: state.deepLink,
        });
      }
      environments.set(environmentId, rows);
    }
    return environments;
  }).pipe(
    Atom.withRefresh("1 minute"),
    Atom.withLabel("mobile:agent-awareness:live-widget-activities"),
  );
}

function rowPriority(row: AgentActivityRowProps): number {
  if (row.phase === "waiting_for_approval" || row.phase === "waiting_for_input") return 0;
  if (row.phase === "failed") return 1;
  return isActive(row) ? 2 : 3;
}

export function sameWidgetEnvironmentScope(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}

/** A disconnect is not a newer observation. Omitted capped rows cannot confirm completion. */
export function retainUnconfirmedWidgetActivities(
  observed: LiveWidgetActivities,
  live: LiveWidgetActivities,
  readStartedWith: LiveWidgetActivities,
  snapshot: RelayAgentActivitySnapshotResponse,
): LiveWidgetActivities {
  if ((snapshot.excludedEnvironmentIds?.length ?? 0) > 0) return observed;
  const relayRows = snapshot.aggregate?.activities ?? [];
  const complete =
    snapshot.aggregate === null ||
    (snapshot.aggregate.activeCount === relayRows.filter(isActive).length &&
      snapshot.aggregate.totalCount !== undefined &&
      snapshot.aggregate.totalCount === relayRows.length);
  const retained = new Map(observed);
  for (const [environmentId, rows] of observed) {
    if (live.has(environmentId) || readStartedWith.get(environmentId) !== rows) continue;
    const environmentRows = relayRows.filter((row) => row.environmentId === environmentId);
    const confirmed =
      rows.length === 0
        ? complete
        : rows.every(
            (row) =>
              environmentRows.some(
                (remote) =>
                  remote.threadId === row.threadId &&
                  (remote.updatedAt > row.updatedAt ||
                    (remote.updatedAt === row.updatedAt && remote.phase === row.phase)),
              ) ||
              (complete &&
                !isActive(row) &&
                !environmentRows.some((remote) => remote.threadId === row.threadId)),
          );
    if (confirmed) retained.delete(environmentId);
  }
  return retained;
}

/** Null means the capped legacy response cannot establish the combined total. */
export function reconcileWidgetActivity(
  live: LiveWidgetActivities,
  snapshot: RelayAgentActivitySnapshotResponse | null,
) {
  const aggregate = snapshot?.aggregate;
  const relayRows = aggregate?.activities ?? [];
  const remoteRows = relayRows.filter((row) => !live.has(row.environmentId));
  const localRows = [...live.values()].flat();
  const localActiveCount = localRows.filter(isActive).length;
  const visibleRelayActiveCount = relayRows.filter(isActive).length;
  const relayCountIsComplete =
    snapshot !== null &&
    (aggregate === null ||
      aggregate === undefined ||
      aggregate.activeCount === visibleRelayActiveCount);
  const acknowledgedScope = snapshot?.excludedEnvironmentIds;
  const exactScope =
    acknowledgedScope !== undefined &&
    sameWidgetEnvironmentScope(acknowledgedScope, [...live.keys()]);
  const globalScope = (acknowledgedScope?.length ?? 0) === 0;
  let activeCount: number | null = null;
  if (snapshot !== null) {
    if (exactScope) {
      activeCount = localActiveCount + (aggregate?.activeCount ?? 0);
    } else if (globalScope) {
      if (live.size === 0) activeCount = aggregate?.activeCount ?? 0;
      else if (relayCountIsComplete)
        activeCount = localActiveCount + remoteRows.filter(isActive).length;
    }
  }
  const allRows = [...localRows, ...remoteRows];
  const mergedCount = (
    key: "workingCount" | "attentionCount" | "totalCount",
    matches: (row: AgentActivityRowProps) => boolean,
  ): number | null => {
    const localCount = localRows.filter(matches).length;
    const remoteCount = aggregate?.[key];
    if (snapshot === null) return null;
    if (exactScope && (remoteCount !== undefined || aggregate == null))
      return localCount + (remoteCount ?? 0);
    if (globalScope && live.size === 0 && remoteCount !== undefined) return remoteCount;
    if (globalScope && (aggregate == null || aggregate.totalCount === relayRows.length))
      return allRows.filter(matches).length;
    if (key !== "totalCount" && globalScope && relayCountIsComplete)
      return allRows.filter(matches).length;
    return null;
  };
  const workingCount = mergedCount(
    "workingCount",
    (row) => row.phase === "running" || row.phase === "starting",
  );
  const attentionCount = mergedCount(
    "attentionCount",
    (row) => row.phase === "waiting_for_input" || row.phase === "waiting_for_approval",
  );
  const totalCount = mergedCount("totalCount", () => true);
  const activities = allRows
    .sort(
      (left, right) =>
        rowPriority(left) - rowPriority(right) || right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, MAX_WIDGET_ROWS);
  return { activeCount, workingCount, attentionCount, totalCount, activities };
}

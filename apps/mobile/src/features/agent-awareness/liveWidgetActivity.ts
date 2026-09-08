import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayAgentActivitySnapshotResponse } from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import type { AgentActivityRowProps } from "../../widgets/AgentActivity";

export type LiveWidgetActivities = ReadonlyMap<EnvironmentId, ReadonlyArray<AgentActivityRowProps>>;

const TERMINAL_DISPLAY_MS = 15 * 60 * 1_000;
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
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
      const snapshot = shell.snapshot.value;
      const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
      const rows: AgentActivityRowProps[] = [];
      for (const thread of snapshot.threads) {
        const project = projects.get(thread.projectId);
        if (!project) continue;
        const state = projectThreadAwareness({ environmentId, project, thread });
        if (!state) continue;
        if (
          (state.phase === "completed" || state.phase === "failed") &&
          now - DateTime.makeUnsafe(state.updatedAt).epochMilliseconds > TERMINAL_DISPLAY_MS
        )
          continue;
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
  const complete = (snapshot.aggregate?.activeCount ?? 0) === relayRows.filter(isActive).length;
  const retained = new Map(observed);
  for (const [environmentId, rows] of observed) {
    if (live.has(environmentId) || readStartedWith.get(environmentId) !== rows) continue;
    const environmentRows = relayRows.filter((row) => row.environmentId === environmentId);
    const confirmed =
      rows.length === 0
        ? complete && environmentRows.every((row) => !isActive(row))
        : rows.every((row) =>
            environmentRows.some(
              (remote) =>
                remote.threadId === row.threadId &&
                (remote.updatedAt > row.updatedAt ||
                  (remote.updatedAt === row.updatedAt && remote.phase === row.phase)),
            ),
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
  const activeCount =
    snapshot === null
      ? null
      : exactScope
        ? localActiveCount + (aggregate?.activeCount ?? 0)
        : !globalScope
          ? null
          : live.size === 0
            ? (aggregate?.activeCount ?? 0)
            : relayCountIsComplete
              ? localActiveCount + remoteRows.filter(isActive).length
              : null;
  const activities = [...localRows, ...remoteRows]
    .sort(
      (left, right) =>
        rowPriority(left) - rowPriority(right) || right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, MAX_WIDGET_ROWS);
  return { activeCount, activities };
}

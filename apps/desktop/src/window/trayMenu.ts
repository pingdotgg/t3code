import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import {
  projectThreadAwareness,
  type AgentAwarenessPhase,
} from "@t3tools/shared/agentAwareness";

export interface TrayThreadRow {
  readonly title: string;
  readonly headline: string;
}

export interface TrayProjectRow {
  readonly title: string;
  readonly activeCount: number;
  readonly threads: readonly TrayThreadRow[];
}

/**
 * What the tray menu's agents section shows: "unavailable" when no shell
 * snapshot could be loaded (backend down, not yet started, auth failure),
 * "empty" when the backend answered but no agent is live, otherwise the
 * per-project rows.
 */
export type TrayAgentsModel =
  | { readonly kind: "unavailable" }
  | { readonly kind: "empty" }
  | { readonly kind: "projects"; readonly projects: readonly TrayProjectRow[] };

// An agent counts as running while it works or waits on the user —
// the same live set the mobile Live Activity surfaces.
const ACTIVE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

export function buildTrayAgentsModel(
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot | null,
): TrayAgentsModel {
  if (snapshot === null) {
    return { kind: "unavailable" };
  }

  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const rowsByProject = new Map<string, { title: string; threads: TrayThreadRow[] }>();

  for (const thread of snapshot.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const project = projectById.get(thread.projectId);
    if (project === undefined) {
      continue;
    }
    const awareness = projectThreadAwareness({ environmentId, project, thread });
    if (awareness === null || !ACTIVE_PHASES.has(awareness.phase)) {
      continue;
    }
    const row = rowsByProject.get(thread.projectId) ?? { title: project.title, threads: [] };
    row.threads.push({ title: awareness.threadTitle, headline: awareness.headline });
    rowsByProject.set(thread.projectId, row);
  }

  if (rowsByProject.size === 0) {
    return { kind: "empty" };
  }

  const projects = [...rowsByProject.values()]
    .map(
      (row): TrayProjectRow => ({
        title: row.title,
        activeCount: row.threads.length,
        threads: row.threads,
      }),
    )
    .sort((a, b) => a.title.localeCompare(b.title));

  return { kind: "projects", projects };
}

export function trayProjectRowLabel(row: TrayProjectRow): string {
  return `${row.title} — ${row.activeCount} ${row.activeCount === 1 ? "agent" : "agents"}`;
}

export function trayThreadRowLabel(row: TrayThreadRow): string {
  return `${row.title} — ${row.headline}`;
}

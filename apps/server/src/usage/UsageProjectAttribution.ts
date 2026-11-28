import type { UsageProject } from "@t3tools/contracts";
import type { ProviderSessionProjectRow } from "../orchestration-v2/ProjectStore.ts";

export const sessionKey = (driver: string, nativeId: string) => `${driver}\u0000${nativeId}`;

/** Keyed by `sessionKey`. A session claimed by threads in different projects belongs to neither. */
export function projectsBySession(
  rows: ReadonlyArray<ProviderSessionProjectRow>,
): ReadonlyMap<string, UsageProject> {
  const claimed = new Map<string, UsageProject | null>();
  for (const row of rows) {
    const key = sessionKey(row.driver, row.nativeId);
    const existing = claimed.get(key);
    if (existing !== undefined) {
      if (existing?.projectId !== row.projectId) claimed.set(key, null);
      continue;
    }
    const title =
      row.title.trim() ||
      row.workspaceRoot.split(/[\\/]/).findLast((part) => part.length > 0) ||
      "Untitled project";
    claimed.set(key, { projectId: row.projectId, title });
  }
  const projects = new Map<string, UsageProject>();
  for (const [key, project] of claimed) if (project !== null) projects.set(key, project);
  return projects;
}

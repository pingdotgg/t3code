import type { ProjectId } from "@t3tools/contracts";

/** Archived threads are absent from the live shell snapshot, so confirmed project removal must force deletion. */
export function projectDeleteCommandInput(projectId: ProjectId): {
  readonly projectId: ProjectId;
  readonly force: true;
} {
  return { projectId, force: true };
}

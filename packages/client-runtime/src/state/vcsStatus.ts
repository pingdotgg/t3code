import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly projectId?: ProjectId | null;
}

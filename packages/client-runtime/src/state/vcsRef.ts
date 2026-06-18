import type { EnvironmentId, VcsRef as ContractVcsRef } from "@t3tools/contracts";

export interface VcsRefTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}

export type VcsRef = ContractVcsRef;

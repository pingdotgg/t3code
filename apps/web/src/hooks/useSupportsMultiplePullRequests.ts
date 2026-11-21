import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentServerConfigLoaded } from "~/state/entities";

export function useSupportsMultiplePullRequests(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentServerConfigLoaded(environmentId);
}

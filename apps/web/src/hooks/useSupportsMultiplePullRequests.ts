import type { EnvironmentId } from "@t3tools/contracts";
import { useHasServerConfig } from "~/state/entities";

export function useSupportsMultiplePullRequests(environmentId: EnvironmentId | null): boolean {
  return useHasServerConfig(environmentId);
}

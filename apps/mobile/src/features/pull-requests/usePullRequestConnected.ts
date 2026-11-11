import { useWorkspaceEnvironments } from "../../state/workspace";

export function usePullRequestConnected(environmentId: string) {
  return useWorkspaceEnvironments().some(
    (environment) =>
      environment.environmentId === environmentId && environment.connectionState === "connected",
  );
}

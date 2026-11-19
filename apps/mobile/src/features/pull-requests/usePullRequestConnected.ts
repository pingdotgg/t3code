import { useWorkspaceEnvironments } from "../../state/workspace";
import { isFixturePullRequestEnvironment } from "./pullRequestFixtures";

export function usePullRequestConnected(environmentId: string) {
  const environments = useWorkspaceEnvironments();
  return (
    isFixturePullRequestEnvironment(environmentId) ||
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && environment.connectionState === "connected",
    )
  );
}

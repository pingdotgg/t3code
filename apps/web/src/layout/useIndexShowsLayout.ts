import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";

/**
 * Whether the index ("/") shows the layout: what it holds, or its empty
 * workspace's launcher. Before there is anything to start a thread in, the
 * index route's own onboarding shows instead (no projects, no environment).
 */
export function useIndexShowsLayout(hostedStatic: boolean): boolean {
  const { environments, isReady } = useEnvironments();
  const hasProjects = useProjects().length > 0;
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  if (hostedStatic && (!isReady || environments.length === 0)) {
    return false;
  }
  return hasProjects || !bootstrapped;
}

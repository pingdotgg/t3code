import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveAccessEnvironmentId } from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/**
 * The environments Sharing & access manages and the one `requested` resolves to. Desktop-local
 * backends stay listed because a Windows app runs its WSL backend as its own environment.
 */
export function useAccessEnvironment(requested: EnvironmentId | null) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId === primaryEnvironmentId ||
      environment.environmentId === requested ||
      environment.entry.enabled,
  );
  const environmentId = resolveAccessEnvironmentId({
    primaryEnvironmentId,
    environments: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
    })),
    selected: requested,
  });
  const environment =
    candidates.find((candidate) => candidate.environmentId === environmentId) ?? null;
  return {
    candidates,
    environment,
    label: environment ? settingsScopeEnvironmentLabel(environment, candidates) : null,
  };
}

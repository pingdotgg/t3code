import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { resolveAccessEnvironmentId } from "./ConnectionsSettings.logic";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

/**
 * The environments Sharing & access manages, the one `requested` resolves to, and its name.
 * The MCP wizard uses the same, so both name an environment alike. A desktop-local WSL backend
 * runs its own server with its own access, so it is a candidate too.
 */
export function useAccessEnvironment(requested: EnvironmentId | null) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId === primaryEnvironmentId ||
      environment.environmentId === requested ||
      (environment.entry.enabled && !environment.boatCloud && !environment.boxdCloud),
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

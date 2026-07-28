import { useAtomValue } from "@effect/atom-react";
import type { ServerConfig } from "@t3tools/contracts";

import { useActiveEnvironmentId } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";

/**
 * Server configuration for global client surfaces.
 *
 * A managed client keeps using its primary backend. A client without a
 * managed backend follows the active saved environment instead.
 */
export function useDefaultServerConfig(): ServerConfig | null {
  const environmentId = useDefaultEnvironmentId();
  return useAtomValue(serverEnvironment.configValueAtom(environmentId));
}

export function useDefaultEnvironmentId() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useActiveEnvironmentId();
  const { environments } = useEnvironments();
  const activeEnvironmentExists =
    activeEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === activeEnvironmentId);
  return (
    primaryEnvironmentId ??
    (activeEnvironmentExists ? activeEnvironmentId : null) ??
    environments[0]?.environmentId ??
    null
  );
}

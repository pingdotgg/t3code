import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentId,
  managedCapabilityDenial,
} from "@t3tools/contracts";

import { isElectron } from "../env";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { useEnvironment } from "../state/environments";
import { useManagedPolicy } from "../state/managedPolicy";
import { useEnvironmentScope } from "../state/session";
import { hasCloudPublicConfig } from "./publicConfig";
import { isDesktopOwnBackend, resolveT3ConnectTurnOn } from "./t3ConnectState";

/** Whether this client can turn on T3 Connect for `environmentId`, and if not, why. */
export function useT3ConnectTurnOn(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  return resolveT3ConnectTurnOn({
    desktopApp: isElectron,
    ownBackend:
      environment !== null &&
      isDesktopOwnBackend(
        environment.entry.target,
        readPrimaryEnvironmentTarget()?.source === "desktop-managed",
      ),
    cloudConfigured: hasCloudPublicConfig(),
    canReadRelay,
    canWriteRelay,
    connectDenial,
  });
}

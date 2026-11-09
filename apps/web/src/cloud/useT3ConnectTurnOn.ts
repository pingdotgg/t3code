import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentId,
  managedCapabilityDenial,
} from "@t3tools/contracts";

import { isElectron } from "../env";
import { useManagedPolicy } from "../state/managedPolicy";
import { useEnvironmentScope } from "../state/session";
import { useCloudLinkState } from "./cloudLinkState";
import { hasCloudPublicConfig } from "./publicConfig";
import { resolveT3ConnectTurnOn } from "./t3ConnectState";

/** Whether this client can turn on T3 Connect for `environmentId`, and if not, why. */
export function useT3ConnectTurnOn(environmentId: EnvironmentId | null) {
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  const linkState = useCloudLinkState(environmentId).data;
  return resolveT3ConnectTurnOn({
    desktopApp: isElectron,
    linkableHere: linkState?.linkableHere === true,
    cloudConfigured: hasCloudPublicConfig(),
    canReadRelay,
    canWriteRelay,
    connectDenial,
  });
}

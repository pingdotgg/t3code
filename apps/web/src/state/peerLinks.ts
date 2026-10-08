import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";
import { AuthAccessReadScope } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { useEnvironmentsWithScope } from "./session";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

/** Connected environments whose links this session may see, in catalog order. */
export function usePeerLinkHosts() {
  const { environments } = useEnvironments();
  const supported = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.environment.capabilities.peerLinks === true,
      ),
    [environments],
  );
  const readable = useEnvironmentsWithScope(supported, AuthAccessReadScope);
  return useMemo(
    () => supported.filter((environment) => readable.has(environment.environmentId)),
    [readable, supported],
  );
}

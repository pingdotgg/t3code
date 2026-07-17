import { createRelayEnvironmentDiscoveryAtoms } from "@t3tools/client-runtime/state/relay";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayEnvironmentDiscovery: ReturnType<typeof createRelayEnvironmentDiscoveryAtoms> =
  createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime);

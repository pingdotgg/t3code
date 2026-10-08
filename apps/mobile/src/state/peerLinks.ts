import { createPeerLinkEnvironmentAtoms } from "@t3tools/client-runtime/state/peerLinks";

import { connectionAtomRuntime } from "../connection/runtime";

export const peerLinkEnvironment = createPeerLinkEnvironmentAtoms(connectionAtomRuntime);

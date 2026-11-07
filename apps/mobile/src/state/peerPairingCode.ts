import { createPeerPairingCodeMinter } from "@t3tools/client-runtime/state/peerPairingCode";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const mintPairingCodeOn = createPeerPairingCodeMinter(
  connectionAtomRuntime,
  appAtomRegistry,
);

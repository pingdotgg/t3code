import { createNetworkMemberAtoms } from "@t3tools/client-runtime/state/network-members";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { tailnetDevices } from "./tailnetDevices";

export const networkMembers = createNetworkMemberAtoms(connectionAtomRuntime, {
  presentationsAtom: environmentPresentations.presentationsAtom,
  tailnetDevices,
});

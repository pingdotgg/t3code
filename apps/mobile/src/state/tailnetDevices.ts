import {
  createDeviceNetworkCommands,
  createDeviceNetworkHostsAtom,
} from "@t3tools/client-runtime/state/deviceNetwork";
import { createTailnetDeviceAtoms } from "@t3tools/client-runtime/state/tailnetDevices";

import { connectionAtomRuntime } from "../connection/runtime";
import { peerLinkEnvironment } from "./peerLinks";

export const tailnetDevices = createTailnetDeviceAtoms(connectionAtomRuntime);
export const deviceNetwork = createDeviceNetworkCommands(connectionAtomRuntime);
export const deviceNetworkHosts = createDeviceNetworkHostsAtom({
  snapshot: tailnetDevices.snapshot,
  links: peerLinkEnvironment.list,
  mayWrite: tailnetDevices.setAccess.permissionAtom,
});

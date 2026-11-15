import {
  createDeviceNetworkCommands,
  createDeviceNetworkHostsAtom,
} from "@t3tools/client-runtime/state/deviceNetwork";
import { createTailnetDeviceAtoms } from "@t3tools/client-runtime/state/tailnetDevices";

import { connectionAtomRuntime } from "../connection/runtime";

export const tailnetDevices = createTailnetDeviceAtoms(connectionAtomRuntime);
export const deviceNetwork = createDeviceNetworkCommands(connectionAtomRuntime);
export const deviceNetworkHosts = createDeviceNetworkHostsAtom({
  snapshot: tailnetDevices.snapshot,
  mayWrite: tailnetDevices.setAccess.permissionAtom,
});

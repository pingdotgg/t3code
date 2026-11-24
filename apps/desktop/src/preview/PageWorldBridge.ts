import { contextBridge, ipcRenderer } from "electron";

import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
} from "./GuestProtocol.ts";
import { installPageWorld, type PageWorldHost } from "./PageWorld.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
const host: PageWorldHost = process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)
  ? {
      // Only the two passkey channels are reachable from the page's world.
      invokePasskey: (channel, publicKey) =>
        channel === PASSKEY_CREATE_CHANNEL || channel === PASSKEY_GET_CHANNEL
          ? ipcRenderer.invoke(channel, publicKey)
          : Promise.reject(new Error("Unsupported passkey channel.")),
    }
  : {};

/** Installed before any page script runs; calls cross into the page's world and back. */
export const pageWorld: ReturnType<typeof installPageWorld> = contextBridge.executeInMainWorld({
  func: installPageWorld,
  args: [host],
});

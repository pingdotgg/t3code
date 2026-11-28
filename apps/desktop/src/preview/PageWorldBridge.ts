import { contextBridge, ipcRenderer } from "electron";

import {
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_CANCEL_CHANNEL,
  PASSKEY_CREATE_CHANNEL,
  PASSKEY_GET_CHANNEL,
  PASSKEY_PHONE_BRIDGE_ARGUMENT,
} from "./GuestProtocol.ts";
import { installPageWorld, type PageWorldHost } from "./PageWorld.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
const host: PageWorldHost = process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)
  ? {
      // Only the passkey channels are reachable from the page's world.
      invokePasskey: (channel, publicKey, requestId) =>
        channel === PASSKEY_CREATE_CHANNEL ||
        channel === PASSKEY_GET_CHANNEL ||
        channel === PASSKEY_CANCEL_CHANNEL
          ? ipcRenderer.invoke(channel, publicKey, requestId)
          : Promise.reject(new Error("Unsupported passkey channel.")),
      platformAuthenticator: !process.argv.includes(PASSKEY_PHONE_BRIDGE_ARGUMENT),
    }
  : {};

/** Installed before any page script runs; calls cross into the page's world and back. */
export const pageWorld: ReturnType<typeof installPageWorld> = contextBridge.executeInMainWorld({
  func: installPageWorld,
  args: [host],
});

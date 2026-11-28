import { createPreviewTunnelUrlReader } from "@t3tools/client-runtime/state/previewTunnel";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";

/** The environment's tunnel WebSocket URL with a live media ticket, or null when unreachable. */
export const readPreviewTunnelUrl = createPreviewTunnelUrlReader({
  runtime: connectionAtomRuntime,
  registry: appAtomRegistry,
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
});

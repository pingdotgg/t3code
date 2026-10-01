import { createTerminalSessionManager } from "@t3tools/client-runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";

/** Share authoritative metadata, including the initial reconnect snapshot, across worklog rows. */
export const terminalSessionManager = createTerminalSessionManager({
  getRegistry: () => appAtomRegistry,
});

import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const chatHistoryEnvironment = {
  export: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:chat-history:export",
    tag: WS_METHODS.chatHistoryExport,
  }),
  import: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:chat-history:import",
    tag: WS_METHODS.chatHistoryImport,
  }),
  downloadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:chat-history:download-url",
    tag: WS_METHODS.assetsCreateUrl,
  }),
};

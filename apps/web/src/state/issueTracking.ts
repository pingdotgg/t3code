import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const issueTrackingEnvironment = {
  linearStatus: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:linear-status",
    tag: WS_METHODS.linearConnectionStatus,
    staleTimeMs: 15_000,
  }),
  linearConnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:linear-connect",
    tag: WS_METHODS.linearConnect,
  }),
  linearDisconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:linear-disconnect",
    tag: WS_METHODS.linearDisconnect,
  }),
  linearSetProjectBinding: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:linear-set-project-binding",
    tag: WS_METHODS.linearSetProjectBinding,
  }),
};

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const issueTrackingEnvironment = {
  status: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:status",
    tag: WS_METHODS.issueTrackersStatus,
    staleTimeMs: 15_000,
  }),
  connect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:connect",
    tag: WS_METHODS.issueTrackersConnect,
  }),
  disconnect: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:disconnect",
    tag: WS_METHODS.issueTrackersDisconnect,
  }),
  bind: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issue-tracking:bind",
    tag: WS_METHODS.issueTrackersBind,
  }),
};

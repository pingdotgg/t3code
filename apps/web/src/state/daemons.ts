import { DAEMON_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const daemonsEnvironment = {
  live: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:daemons:live",
    tag: DAEMON_WS_METHODS.subscribe,
  }),
  upsert: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:daemons:upsert",
    tag: DAEMON_WS_METHODS.upsert,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:daemons:delete",
    tag: DAEMON_WS_METHODS.delete,
  }),
  restart: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:daemons:restart",
    tag: DAEMON_WS_METHODS.restart,
  }),
};

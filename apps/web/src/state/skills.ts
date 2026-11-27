import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const skillsListLibrary = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skills:list-library",
  tag: WS_METHODS.skillsListLibrary,
});

export const skillsReadBundle = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skills:read-bundle",
  tag: WS_METHODS.skillsReadBundle,
});

export const skillsInject = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:skills:inject",
  tag: WS_METHODS.skillsInject,
});

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
export const tasksExecute = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "tasks",
  tag: WS_METHODS.tasksExecute,
});
export const tasksConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "tasks:configure",
  tag: WS_METHODS.tasksConfigure,
});
export const taskLinks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "tasks:links",
  tag: WS_METHODS.tasksExecute,
  staleTimeMs: 10_000,
});

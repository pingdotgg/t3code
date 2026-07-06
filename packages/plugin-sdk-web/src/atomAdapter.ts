import { appAtomRegistry } from "../../../apps/web/src/rpc/atomRegistry.ts";
import { connectionAtomRuntime } from "../../../apps/web/src/connection/runtime.ts";

export function getAppAtomRegistry() {
  return appAtomRegistry;
}

export function getConnectionAtomRuntime() {
  return connectionAtomRuntime;
}

export function createPluginAtoms() {
  return {
    registry: appAtomRegistry,
    runtime: connectionAtomRuntime,
  };
}

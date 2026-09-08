import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Server-pushed device hosts, devices, and open sessions for one environment. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:state",
      tag: WS_METHODS.subscribeDeviceState,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:list",
      tag: WS_METHODS.deviceList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:open",
      tag: WS_METHODS.deviceOpen,
      scheduler,
      concurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:close",
      tag: WS_METHODS.deviceClose,
      scheduler,
      concurrency,
    }),
    shutdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:shutdown",
      tag: WS_METHODS.deviceShutdown,
      scheduler,
      concurrency,
    }),
    detail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:detail",
      tag: WS_METHODS.deviceDetail,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:action",
      tag: WS_METHODS.deviceAction,
      scheduler,
      concurrency,
    }),
  };
}

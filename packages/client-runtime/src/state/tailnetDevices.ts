import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Your tailnet devices as one environment sees them, and the changes it can make. */
export function createTailnetDeviceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tailnet-devices:list",
    tag: WS_METHODS.tailnetDevicesList,
    staleTimeMs: 10_000,
  });
  return {
    list,
    /** The snapshot now and after every change, pushed by the environment. */
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:tailnet-devices:snapshot",
      tag: WS_METHODS.subscribeTailnetDevices,
    }),
    setAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:set-access",
      tag: WS_METHODS.tailnetDevicesSetAccess,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    admit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:admit",
      tag: WS_METHODS.tailnetDevicesAdmit,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    setAppAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:set-app-access",
      tag: WS_METHODS.tailnetDevicesSetAppAccess,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    openDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:open-device",
      tag: WS_METHODS.tailnetDevicesOpenDevice,
    }),
  };
}

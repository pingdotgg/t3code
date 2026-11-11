import { WS_METHODS, type CursorCloudMachineState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const CURSOR_CLOUD_MACHINE_LABELS: Record<CursorCloudMachineState, string> = {
  pending: "Not started",
  starting: "Starting",
  running: "Running",
  asleep: "Asleep",
  expired: "Expired",
  error: "Error",
};

export function createCursorCloudAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "cursor-cloud:status",
    tag: WS_METHODS.cursorCloudStatus,
  });
  return {
    status,
    machine: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "cursor-cloud:machine",
      tag: WS_METHODS.cursorCloudSubscribeMachine,
    }),
    wakeMachine: createEnvironmentRpcCommand(runtime, {
      label: "cursor-cloud:wake-machine",
      tag: WS_METHODS.cursorCloudWakeMachine,
    }),
    connect: createEnvironmentRpcCommand(runtime, {
      label: "cursor-cloud:connect",
      tag: WS_METHODS.cursorCloudConnect,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "cursor-cloud:disconnect",
      tag: WS_METHODS.cursorCloudDisconnect,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(status({ environmentId, input: {} }))),
    }),
  };
}

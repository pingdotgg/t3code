import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Commands for an environment's own APNs push, used where T3 Connect is not configured. */
export function createDirectPushCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <TTag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    name: string,
    tag: TTag,
  ) => createEnvironmentRpcCommand(runtime, { label: `environment-data:direct-push:${name}`, tag });

  return {
    registerDevice: command("register-device", WS_METHODS.directPushRegisterDevice),
    unregisterDevice: command("unregister-device", WS_METHODS.directPushUnregisterDevice),
    getStatus: command("get-status", WS_METHODS.directPushGetStatus),
    setCredentials: command("set-credentials", WS_METHODS.directPushSetCredentials),
    clearCredentials: command("clear-credentials", WS_METHODS.directPushClearCredentials),
    sendTest: command("send-test", WS_METHODS.directPushSendTest),
  };
}

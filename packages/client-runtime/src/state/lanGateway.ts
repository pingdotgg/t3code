import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createLanGatewayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:lan-gateway:list",
    tag: WS_METHODS.lanGatewayList,
    staleTimeMs: 10_000,
  });
  return {
    list,
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:lan-gateway:add",
      tag: WS_METHODS.lanGatewayAdd,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:lan-gateway:remove",
      tag: WS_METHODS.lanGatewayRemove,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
  };
}

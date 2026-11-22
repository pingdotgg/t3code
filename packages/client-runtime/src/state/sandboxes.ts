import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const environmentConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  const perSandboxConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { readonly id: string } }) =>
      `${environmentId}:${input.id}`,
  };

  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:sandboxes:state",
      tag: WS_METHODS.sandboxesSubscribe,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:sandboxes:list",
      tag: WS_METHODS.sandboxesList,
    }),
    spawn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:spawn",
      tag: WS_METHODS.sandboxesSpawn,
      scheduler,
      concurrency: environmentConcurrency,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:resume",
      tag: WS_METHODS.sandboxesResume,
      scheduler,
      concurrency: perSandboxConcurrency,
    }),
    snapshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:snapshot",
      tag: WS_METHODS.sandboxesSnapshot,
      scheduler,
      concurrency: perSandboxConcurrency,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:stop",
      tag: WS_METHODS.sandboxesStop,
      scheduler,
      concurrency: perSandboxConcurrency,
    }),
    destroy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sandboxes:destroy",
      tag: WS_METHODS.sandboxesDestroy,
      scheduler,
      concurrency: perSandboxConcurrency,
    }),
  };
}

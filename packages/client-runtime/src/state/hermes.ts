import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createHermesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "singleFlight" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly providerInstanceId: string };
    }) => JSON.stringify([environmentId, input.providerInstanceId]),
  };

  return {
    discoverSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hermes:sessions:discover",
      tag: WS_METHODS.hermesSessionsDiscover,
      scheduler,
      concurrency,
    }),
    importSessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hermes:sessions:import",
      tag: WS_METHODS.hermesSessionsImport,
      scheduler,
      concurrency,
    }),
    resetHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hermes:history:reset",
      tag: WS_METHODS.hermesHistoryReset,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}

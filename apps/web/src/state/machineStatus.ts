import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type MachineStatus, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export interface MachineEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** null while the environment is offline or its server sent nothing yet. */
  readonly status: MachineStatus | null;
}

// Polls only while the machine bar reads it; servers cache a sample for 5 s.
const machineStatusQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:machine-status",
  tag: WS_METHODS.serverGetMachineStatus,
  staleTimeMs: 20_000,
  refreshIntervalMs: 25_000,
  idleTtlMs: 0,
});

/** True when an enabled environment's server reports its machine. */
export const machineBarAvailableAtom = Atom.make((get) =>
  [...get(environmentPresentations.serverConfigsAtom).values()].some(
    (config) => config.environment.capabilities.machineStatus === true,
  ),
).pipe(Atom.withLabel("web-machine-bar-available"));

/** Enabled environments that report their machine, in catalog order. */
export const machineEnvironmentsAtom = Atom.make((get): ReadonlyArray<MachineEnvironment> => {
  const environments: MachineEnvironment[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (!presentation.entry.enabled) continue;
    if (presentation.serverConfig?.environment.capabilities.machineStatus !== true) continue;
    // A query keeps its last answer through a reconnect; an offline machine must read "off".
    const result =
      presentation.connection.phase === "connected"
        ? get(machineStatusQuery({ environmentId, input: {} }))
        : null;
    environments.push({
      environmentId,
      label: presentation.entry.target.label,
      status: result?._tag === "Success" ? result.value : null,
    });
  }
  return environments;
}).pipe(Atom.withLabel("web-machine-environments"));

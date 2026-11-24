import { type EnvironmentId, type ServerSettings, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createForkRolesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  settingsValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerSettings | null>,
) {
  const directoryAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(settingsValueAtom(environmentId))?.forkRolesDirectory ?? null).pipe(
      Atom.withLabel(`environment-data:fork-roles:directory:${environmentId}`),
    ),
  );
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:fork-roles:list",
      tag: WS_METHODS.forkRolesList,
      refreshTrigger: ({ environmentId }) => directoryAtom(environmentId),
    }),
  };
}

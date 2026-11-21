import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentPluginAtoms } from "@t3tools/client-runtime/state/plugins";
import type { EnvironmentId, PluginSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";

export const pluginEnvironment = createEnvironmentPluginAtoms(connectionAtomRuntime);
const emptySnapshotAtom = Atom.make(AsyncResult.initial<PluginSnapshot, never>(false));

export function usePluginSnapshot(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null ? emptySnapshotAtom : pluginEnvironment.snapshotAtom(environmentId),
  );
}

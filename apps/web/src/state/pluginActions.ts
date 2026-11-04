import { useAtomValue } from "@effect/atom-react";
import { createPluginActionEnvironmentAtoms } from "@t3tools/client-runtime/state/pluginActions";
import type { EnvironmentId, PluginAction } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";

export const pluginActionEnvironment = createPluginActionEnvironmentAtoms(connectionAtomRuntime);

const NO_ACTIONS: ReadonlyArray<PluginAction> = [];

const snapshotAtom = (environmentId: EnvironmentId) =>
  pluginActionEnvironment.snapshot({ environmentId, input: {} });

/** The environment's plugin actions, kept current while the caller is mounted. */
export function usePluginActions(environmentId: EnvironmentId | null): ReadonlyArray<PluginAction> {
  return (
    useEnvironmentQuery(environmentId === null ? null : snapshotAtom(environmentId)).data
      ?.actions ?? NO_ACTIONS
  );
}

/** Keeps one environment's list subscribed so menus built on demand read it current. */
export function useMountPluginActions(environmentId: EnvironmentId): void {
  useAtomValue(snapshotAtom(environmentId));
}

/** The list as last received, for menus built when they open. */
export function readPluginActions(environmentId: EnvironmentId): ReadonlyArray<PluginAction> {
  return Option.match(AsyncResult.value(appAtomRegistry.get(snapshotAtom(environmentId))), {
    onNone: () => NO_ACTIONS,
    onSome: (snapshot) => snapshot.actions,
  });
}

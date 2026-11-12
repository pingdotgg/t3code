import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make<EnvironmentShellState>(EMPTY_SHELL_STATE);

const shellStatus = (state: EnvironmentShellState) => state.status;
const shellHasError = (state: EnvironmentShellState) => Option.isSome(state.error);
// The empty placeholder stands until the environment has read its cached shell.
const shellCacheRead = (state: EnvironmentShellState) => state !== EMPTY_SHELL_STATE;

const shellCacheReadAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => shellCacheRead(get(environmentShell.stateValueAtom(environmentId)))),
);

/**
 * True once every enabled environment has read its cached shell. A list that paints before
 * then gets the cached rows of one environment at a time.
 */
export const shellCachesReadAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return false;
  // Reads every environment, so each one loads its cache now and not after the one before it.
  let allRead = true;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (!get(shellCacheReadAtom(environmentId))) allRead = false;
  }
  return allRead;
}).pipe(Atom.withLabel("mobile-shell-caches-read"));

export function useEnvironmentShellReadiness(environmentId: EnvironmentId | null) {
  const atom =
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateValueAtom(environmentId);
  return {
    status: useAtomValue(atom, shellStatus),
    hasError: useAtomValue(atom, shellHasError),
    cacheRead: useAtomValue(atom, shellCacheRead),
  };
}

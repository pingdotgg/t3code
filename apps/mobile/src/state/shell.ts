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

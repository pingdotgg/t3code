import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make<EnvironmentShellState>({
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
}).pipe(Atom.withLabel("mobile-environment-shell:empty"));

export function useEnvironmentShellState(
  environmentId: EnvironmentId | null,
): EnvironmentShellState {
  return useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateValueAtom(environmentId),
  );
}

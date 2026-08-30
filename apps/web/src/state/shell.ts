import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  shellStreamHealth,
  type ShellStreamHealth,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

/**
 * Derived per-environment shell stream health (the latch lives in the shell
 * state machine itself, so environments without a mounted consumer still
 * track attach/drop). Deriving here lets the atom's Object.is dedupe absorb
 * per-item shell churn: rows re-render only on actual health flips.
 */
const shellStreamHealthAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => shellStreamHealth(get(environmentShell.stateValueAtom(environmentId)))).pipe(
    Atom.withLabel(`web-shell-stream-health:${environmentId}`),
  ),
);

/** Shell stream health for one environment (drives Working/Connecting/Reconnecting pills). */
export function useShellStreamHealth(environmentId: EnvironmentId): ShellStreamHealth {
  return useAtomValue(shellStreamHealthAtom(environmentId));
}

const healthByEnvironmentInAtom = Atom.family((environmentsKey: string) =>
  Atom.make((get) => {
    // Empty member list: no health lookups.
    if (environmentsKey === "") return {};
    // Null prototype: environment ids are server data, and a "__proto__" key
    // must not resolve to Object.prototype.
    const healths: Record<string, ShellStreamHealth> = Object.create(null);
    for (const environmentId of environmentsKey.split("\u0000")) {
      healths[environmentId] = get(shellStreamHealthAtom(environmentId as EnvironmentId));
    }
    return healths;
  }).pipe(Atom.withLabel(`web-shell-stream-health-by-environments:${environmentsKey}`)),
);

/** Shell stream health for a set of environments, keyed by environment id (rollup paths). */
export function useShellStreamHealthForEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Record<string, ShellStreamHealth> {
  return useAtomValue(healthByEnvironmentInAtom([...environmentIds].sort().join("\u0000")));
}

import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createHomeEnvironmentAtoms } from "@t3tools/client-runtime/state/home";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

export const homeEnvironment = createHomeEnvironmentAtoms(connectionAtomRuntime);

let previousLiveEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();
/** Environments whose thread list is live, so a thread missing from it is really gone. */
export const liveShellEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set<EnvironmentId>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) next.add(environmentId);
  }
  if (
    next.size === previousLiveEnvironmentIds.size &&
    [...next].every((environmentId) => previousLiveEnvironmentIds.has(environmentId))
  ) {
    return previousLiveEnvironmentIds;
  }
  previousLiveEnvironmentIds = next;
  return next;
}).pipe(Atom.withLabel("web-home-live-shell-environments"));

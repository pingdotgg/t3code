import type { ServerProvider } from "@t3tools/contracts";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "./projects";

const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** The providers T3 reports for the engine, with the usage limits it probed. */
export const engineProvidersAtom = Atom.make((get): ReadonlyArray<ServerProvider> => {
  const [entry] = get(environmentCatalog.catalogValueAtom).entries.values();
  if (entry === undefined) return NO_PROVIDERS;
  return (
    get(serverEnvironment.configValueAtom(entry.target.environmentId))?.providers ?? NO_PROVIDERS
  );
}).pipe(Atom.withLabel("engine-providers"));

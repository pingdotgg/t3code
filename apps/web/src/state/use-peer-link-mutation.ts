import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

// Pairing and the subsequent write share a lock that outlives rows and Settings.
const pendingAtom = Atom.family((sourceId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`peer-links:mutation:${sourceId}`)),
);

export function usePeerLinkMutation(sourceId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const atom = pendingAtom(sourceId);
  const pending = useAtomValue(atom);
  return {
    pending,
    start: () => {
      if (registry.get(atom)) return false;
      registry.set(atom, true);
      return true;
    },
    finish: () => registry.set(atom, false),
  };
}

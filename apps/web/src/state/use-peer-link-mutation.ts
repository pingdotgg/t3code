import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext, useEffect } from "react";

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

const confirmedAccessAtom = Atom.family((key: string) =>
  Atom.make<AuthMcpClientAccess | null>(null).pipe(Atom.keepAlive, Atom.withLabel(key)),
);

export function usePeerLinkAccess(
  sourceId: EnvironmentId,
  destinationId: EnvironmentId,
  serverAccess: AuthMcpClientAccess,
) {
  const registry = useContext(RegistryContext);
  const atom = confirmedAccessAtom(JSON.stringify([sourceId, destinationId]));
  const confirmed = useAtomValue(atom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clear the shared confirmation once the server query catches up
  useEffect(() => {
    if (confirmed === serverAccess) registry.set(atom, null);
  }, [atom, confirmed, registry, serverAccess]);
  return {
    access: confirmed ?? serverAccess,
    confirm: (access: AuthMcpClientAccess) => registry.set(atom, access),
  };
}

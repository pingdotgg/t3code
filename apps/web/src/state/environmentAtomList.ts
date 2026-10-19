import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export const environmentIdsKey = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  environmentIds.join("\n");

/**
 * Reads one per-environment atom for a list of environments. The list is keyed by its ids, so
 * renders that rebuild an equal list read the same atom instead of a new one whose fresh
 * snapshot would schedule another render.
 */
export function environmentAtomList<A>(
  label: string,
  atom: (environmentId: EnvironmentId) => Atom.Atom<A>,
) {
  return Atom.family((key: string) =>
    Atom.make((get) =>
      key === "" ? [] : (key.split("\n") as EnvironmentId[]).map((id) => get(atom(id))),
    ).pipe(Atom.withLabel(`${label}:${key}`)),
  );
}

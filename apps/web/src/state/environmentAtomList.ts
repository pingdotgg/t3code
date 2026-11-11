import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export const environmentIdsKey = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  environmentIds.join("\n");

/** Key by environment ids so equal input lists reuse the atom and snapshot. */
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

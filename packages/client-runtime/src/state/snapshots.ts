import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentShellState } from "./shell.ts";

export function createEnvironmentSnapshotAtom<E>(
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): OrchestrationShellSnapshot | null =>
      Option.match(AsyncResult.value(get(shellStateAtom(environmentId))), {
        onNone: () => null,
        onSome: (state) => Option.getOrNull(state.snapshot),
      }),
    ).pipe(Atom.withLabel(`environment-snapshot:${environmentId}`)),
  );
}

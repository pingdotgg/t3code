import { threadMoveTargets } from "@t3tools/client-runtime/thread-move";
import { createThreadMoveCommands } from "@t3tools/client-runtime/state/thread-move-commands";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const threadMove = createThreadMoveCommands(connectionAtomRuntime);

/** Connected machines other than the thread's own where this client may start the moved thread. */
export const threadMoveTargetsAtom = Atom.family((sourceEnvironmentId: EnvironmentId) =>
  Atom.make((get) => {
    const environments = [...get(environmentPresentations.presentationsAtom)]
      .filter(([, presentation]) => presentation.connection.phase === "connected")
      .map(([environmentId, presentation]) => ({
        environmentId,
        label: presentation.entry.target.label,
        machine: resolveEnvironmentMachineKind(presentation.serverConfig),
      }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
    return threadMoveTargets(sourceEnvironmentId, environments, (environmentId) =>
      get(threadMove.importPermissionAtom(environmentId)),
    );
  }).pipe(Atom.withLabel(`web-thread-move-targets:${sourceEnvironmentId}`)),
);

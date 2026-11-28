import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import { createThreadMoveCommands } from "@t3tools/client-runtime/state/thread-move-commands";
import { threadMoveTargets } from "@t3tools/client-runtime/thread-move";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession, sessionHasScope } from "./session";
import { workspaceConnections } from "./workspace";

export const threadMoveCommands = createThreadMoveCommands(connectionAtomRuntime);

const NO_TARGETS_ATOM = Atom.make<ReadonlyArray<EnvironmentConnectionSummary>>([]).pipe(
  Atom.withLabel("mobile-thread-move-targets:none"),
);

/** Connected environments, other than the thread's own, where this client may start threads. */
export const threadMoveTargetsAtom = Atom.family((sourceEnvironmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<EnvironmentConnectionSummary> =>
    threadMoveTargets(
      sourceEnvironmentId,
      get(workspaceConnections.environmentsAtom).filter(
        (environment) => environment.connectionState === "connected",
      ),
      (environmentId) =>
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environmentId)),
          AuthOrchestrationOperateScope,
        ),
    ),
  ).pipe(Atom.withLabel(`mobile-thread-move-targets:${sourceEnvironmentId}`)),
);

// Selects a boolean so list rows do not re-render when an unrelated environment changes.
export function useHasThreadMoveTarget(sourceEnvironmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    sourceEnvironmentId === null ? NO_TARGETS_ATOM : threadMoveTargetsAtom(sourceEnvironmentId),
    (targets) => targets.length > 0,
  );
}

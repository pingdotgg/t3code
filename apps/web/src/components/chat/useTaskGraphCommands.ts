import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type TaskGraph,
  type TaskGraphEdit,
} from "@t3tools/contracts";
import { applyTaskGraphEdits } from "@t3tools/shared/taskGraph";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Graph mutations for the card and the editor. Edits are checked against the
 * graph's current server state before they are sent, so a rule violation shows
 * inline without a round trip; the server re-checks and stays authoritative.
 */
export function useTaskGraphCommands(environmentId: EnvironmentId, graph: TaskGraph) {
  const canEdit = useAtomValue(serverEnvironment.editTaskGraph.permissionAtom(environmentId));
  const canRun = useAtomValue(serverEnvironment.runTaskGraph.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelTaskGraph.permissionAtom(environmentId));
  const editGraph = useAtomCommand(serverEnvironment.editTaskGraph, "task graph edit");
  const runGraph = useAtomCommand(serverEnvironment.runTaskGraph, "task graph run");
  const cancelGraph = useAtomCommand(serverEnvironment.cancelTaskGraph, "task graph cancel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = async (send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    setBusy(true);
    setError(null);
    const message = failureMessage(await send());
    setBusy(false);
    setError(message);
    return message === null;
  };

  /** Resolves true once the server accepted the edits. */
  const edit = (edits: ReadonlyArray<TaskGraphEdit>) => {
    const checked = applyTaskGraphEdits(graph.nodes, edits, new Date().toISOString());
    if (!checked.ok) {
      setError(checked.error);
      return Promise.resolve(false);
    }
    return settle(() => editGraph({ environmentId, input: { graphId: graph.id, edits } }));
  };

  return {
    canEdit,
    canRun,
    canCancel,
    busy,
    error,
    clearError: () => setError(null),
    edit,
    run: () => settle(() => runGraph({ environmentId, input: { graphId: graph.id } })),
    cancel: () => settle(() => cancelGraph({ environmentId, input: { graphId: graph.id } })),
  };
}

export type TaskGraphCommands = ReturnType<typeof useTaskGraphCommands>;

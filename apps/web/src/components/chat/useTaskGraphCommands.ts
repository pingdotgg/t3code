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
  type TaskGraphNode,
  type TaskGraphNodeInput,
  type ThreadId,
} from "@t3tools/contracts";
import { applyTaskGraphEdits, newTaskGraphNode } from "@t3tools/shared/taskGraph";
import { useState } from "react";
import { create } from "zustand";

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

/** The task a graph started from the composer begins with; the editor opens on it. */
const FIRST_TASK: TaskGraphNodeInput = {
  key: "task-1",
  title: "New task",
  prompt: "Describe what this task should do.",
  dependsOn: [],
};

/**
 * A graph whose editor should open as soon as its card mounts. Set when the
 * user starts a graph from the composer, cleared when that editor closes.
 */
export const useTaskGraphEditorRequest = create<{
  readonly graphId: string | null;
  readonly nodeKey: string | null;
  readonly request: (graphId: string, nodeKey: string) => void;
  readonly clear: () => void;
}>((set) => ({
  graphId: null,
  nodeKey: null,
  request: (graphId, nodeKey) => set({ graphId, nodeKey }),
  clear: () => set({ graphId: null, nodeKey: null }),
}));

/**
 * Creates graphs from the composer. `start` puts an empty draft on an
 * existing thread and opens its editor; `create` sends a finished graph.
 * Both resolve to an error message or null.
 */
export function useNewTaskGraph(environmentId: EnvironmentId) {
  const canCreate = useAtomValue(serverEnvironment.createTaskGraph.permissionAtom(environmentId));
  const createGraph = useAtomCommand(serverEnvironment.createTaskGraph, "task graph create");
  const request = useTaskGraphEditorRequest((state) => state.request);
  const send = async (
    threadId: ThreadId,
    nodes: ReadonlyArray<TaskGraphNodeInput>,
    run: boolean,
  ): Promise<{ readonly graphId: string } | { readonly error: string | null }> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return { error: "You don't have permission to start task graphs here." };
    }
    const result = await createGraph({
      environmentId,
      input: { threadId, title: "New task graph", nodes, run },
    });
    return result._tag === "Success"
      ? { graphId: result.value.graph.id }
      : { error: failureMessage(result) };
  };
  const start = async (threadId: ThreadId): Promise<string | null> => {
    const result = await send(threadId, [FIRST_TASK], false);
    if ("error" in result) return result.error;
    request(result.graphId, FIRST_TASK.key);
    return null;
  };
  const createAndRun = async (
    threadId: ThreadId,
    nodes: ReadonlyArray<TaskGraphNode>,
  ): Promise<string | null> => {
    const result = await send(threadId, nodes.map(taskGraphNodeInput), true);
    return "error" in result ? result.error : null;
  };
  return { canCreate, start, createAndRun };
}

function taskGraphNodeInput(node: TaskGraphNode): TaskGraphNodeInput {
  return {
    key: node.key,
    title: node.title,
    prompt: node.prompt,
    dependsOn: node.dependsOn,
    ...(node.pullRequest === null ? {} : { pullRequest: node.pullRequest }),
    ...(node.modelSelection === null ? {} : { modelSelection: node.modelSelection }),
    environmentId: node.environmentId,
    workspace: node.workspace,
    startAt: node.startAt,
  };
}

/**
 * Commands for a graph drafted on a new chat, before its thread exists. Edits
 * stay in the client, checked by the same rules the server applies; `run`
 * hands the nodes to `onRun`, which creates the thread and the graph together.
 */
export function useDraftTaskGraph(input: {
  readonly canRun: boolean;
  readonly onRun: (nodes: ReadonlyArray<TaskGraphNode>) => Promise<string | null>;
  readonly onDiscard: () => void;
}) {
  const [nodes, setNodes] = useState<ReadonlyArray<TaskGraphNode>>(() => [
    newTaskGraphNode(FIRST_TASK),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commands: TaskGraphCommands = {
    canEdit: true,
    canRun: input.canRun,
    canCancel: true,
    busy,
    error,
    clearError: () => setError(null),
    edit: (edits) => {
      const checked = applyTaskGraphEdits(nodes, edits, new Date().toISOString());
      setError(checked.ok ? null : checked.error);
      if (checked.ok) setNodes(checked.nodes);
      return Promise.resolve(checked.ok);
    },
    run: async () => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      const message = await input.onRun(nodes);
      setBusy(false);
      setError(message);
      return message === null;
    },
    cancel: () => {
      setNodes([newTaskGraphNode(FIRST_TASK)]);
      setError(null);
      input.onDiscard();
      return Promise.resolve(true);
    },
  };
  return { nodes, commands, firstNodeKey: FIRST_TASK.key };
}

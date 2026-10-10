import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  TaskGraph,
  TaskGraphNode,
  TaskGraphPeer,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { getTriggerDisplayModelLabel } from "./providerIconUtils";
import { taskGraphNodeMachine, taskGraphNodeModel } from "./taskGraphView";

const EMPTY_PEERS: ReadonlyArray<TaskGraphPeer> = [];

export const TASK_GRAPH_PEER_STATUS_HINT: Record<TaskGraphPeer["status"], string | null> = {
  connected: null,
  connecting: "connecting",
  unreachable: "unreachable",
  unauthorized: "unauthorized",
};

/**
 * Model and machine names for a graph's nodes, resolved against the graph's
 * environment: its provider catalogue for model labels, and its paired peers
 * for machine labels. The card, diagram and editor share one instance.
 */
export function useTaskGraphLabels(environmentId: EnvironmentId, graph: TaskGraph) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const environmentLabel = useEnvironment(environmentId)?.label ?? "This machine";
  // Servers without peer support reject the subscription; the graph's own machine still shows.
  const peersQuery = useEnvironmentQuery(
    serverEnvironment.taskGraphPeersLive({ environmentId, input: {} }),
  );
  const peers = peersQuery.data?.peers ?? EMPTY_PEERS;

  const modelLabel = (selection: ModelSelection): string => {
    const entry = instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = entry?.models.find((candidate) => candidate.slug === selection.model);
    return model ? getTriggerDisplayModelLabel(model) : selection.model;
  };
  const machineLabel = (id: EnvironmentId): string =>
    id === environmentId
      ? environmentLabel
      : (peers.find((peer) => peer.environmentId === id)?.label ?? "Another machine");
  const nodeMachine = (node: TaskGraphNode) => taskGraphNodeMachine(graph.nodes, node);

  return {
    environmentId,
    environmentLabel,
    peers,
    instanceEntries,
    settings,
    providers,
    modelLabel,
    machineLabel,
    /** The node's model, or "Thread default" when neither it nor the graph names one. */
    nodeModelLabel: (node: TaskGraphNode): string => {
      const selection = taskGraphNodeModel(graph, node);
      return selection === null ? "Thread default" : modelLabel(selection);
    },
    /** Where the node runs, or "Auto" while it will be balanced on start. */
    nodeMachineLabel: (node: TaskGraphNode): string => {
      const machine = nodeMachine(node);
      return machine === null ? "Auto" : machineLabel(machine);
    },
  };
}

export type TaskGraphLabels = ReturnType<typeof useTaskGraphLabels>;

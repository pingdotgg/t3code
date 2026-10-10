import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  TaskGraph,
  TaskGraphEdit,
  TaskGraphNode,
  ThreadId,
} from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { taskGraphLayers } from "@t3tools/shared/taskGraph";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import {
  sortTaskGraphs,
  taskGraphActions,
  taskGraphNodeActions,
  taskGraphNodeStatusLabel,
  taskGraphNodeTone,
  taskGraphNodeWaitDetail,
  taskGraphSummaryLabel,
  taskGraphTone,
} from "./task-graph-presentation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type TaskGraphTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const useTaskGraphsQuery = (target: TaskGraphTarget) =>
  useEnvironmentQuery(
    serverEnvironment.taskGraphsLive({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    }),
  );

/** The thread's task graphs, live. Null until the first snapshot arrives. */
export function useThreadTaskGraphs(target: TaskGraphTarget): ReadonlyArray<TaskGraph> | null {
  return useTaskGraphsQuery(target).data?.graphs ?? null;
}

function confirm(input: {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly onConfirm: () => void;
}) {
  if (Platform.OS === "ios") {
    Alert.alert(input.title, input.message, [
      { text: "Keep", style: "cancel" },
      { text: input.confirmText, style: "destructive", onPress: input.onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ ...input, cancelText: "Keep", destructive: true });
}

/**
 * Read-only view of a thread's task graphs, with the actions that move a
 * graph between states: run a draft, cancel, cancel a branch, retry a node.
 * Editing the graph itself happens on web and desktop.
 */
export function TaskGraphSheet({ route }: StaticScreenProps<TaskGraphTarget>) {
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const query = useTaskGraphsQuery(target);
  const graphs = query.data === null ? null : sortTaskGraphs(query.data.graphs);
  const canEdit = useAtomValue(
    serverEnvironment.editTaskGraph.permissionAtom(target.environmentId),
  );
  const canRun = useAtomValue(serverEnvironment.runTaskGraph.permissionAtom(target.environmentId));
  const canCancel = useAtomValue(
    serverEnvironment.cancelTaskGraph.permissionAtom(target.environmentId),
  );
  const editGraph = useAtomCommand(serverEnvironment.editTaskGraph, {
    label: "task graph edit",
    reportFailure: false,
  });
  const runGraph = useAtomCommand(serverEnvironment.runTaskGraph, {
    label: "task graph run",
    reportFailure: false,
  });
  const cancelGraph = useAtomCommand(serverEnvironment.cancelTaskGraph, {
    label: "task graph cancel",
    reportFailure: false,
  });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(target.environmentId));
  const environmentLabel =
    useEnvironmentPresentation(target.environmentId).presentation?.entry.target.label ??
    "This machine";
  // Servers without peer support reject this; the graph's own machine still has a name.
  const peers =
    useEnvironmentQuery(
      serverEnvironment.taskGraphPeersLive({ environmentId: target.environmentId, input: {} }),
    ).data?.peers ?? [];
  const modelLabel = (selection: ModelSelection) =>
    providers
      ?.find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model)?.name ??
    formatModelSlugName(selection.model);
  /** "Claude Opus 5.5 · on build-box": the node's model and where it ran or is pinned. */
  const placementLabel = (graph: TaskGraph, node: TaskGraphNode) => {
    const model = node.modelSelection ?? graph.modelSelection;
    // A node continuing its dependency's worktree goes where that one ran, known once it starts.
    const machine =
      node.assignedEnvironmentId ?? (node.workspace === "dependency" ? null : node.environmentId);
    const machineLabel =
      machine === null
        ? null
        : machine === target.environmentId
          ? environmentLabel
          : (peers.find((peer) => peer.environmentId === machine)?.label ?? "another machine");
    return [
      model === null ? null : modelLabel(model),
      machineLabel === null ? null : `on ${machineLabel}`,
    ]
      .filter((part) => part !== null)
      .join(" · ");
  };
  // Keys of actions in flight, so a second tap cannot send the same edit twice.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const perform = async (
    key: string,
    failureTitle: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setPending((current) => new Set(current).add(key));
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        Alert.alert(failureTitle, String(squashAtomCommandFailure(result)));
      }
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const edit = (graph: TaskGraph, change: TaskGraphEdit & { readonly key: string }) =>
    perform(
      `${graph.id}:${change.key}`,
      change.type === "retry_node" ? "Could not retry task" : "Could not cancel branch",
      () =>
        editGraph({
          environmentId: target.environmentId,
          input: { graphId: graph.id, edits: [change] },
        }),
    );

  const onRun = (graph: TaskGraph) => {
    void Haptics.selectionAsync();
    void perform(graph.id, "Could not run graph", () =>
      runGraph({ environmentId: target.environmentId, input: { graphId: graph.id } }),
    );
  };

  const onCancel = (graph: TaskGraph) =>
    confirm({
      title: "Cancel task graph?",
      message: `Every unfinished task in “${graph.title}” stops. Finished tasks and their pull requests stay.`,
      confirmText: "Cancel graph",
      onConfirm: () =>
        void perform(graph.id, "Could not cancel graph", () =>
          cancelGraph({ environmentId: target.environmentId, input: { graphId: graph.id } }),
        ),
    });

  const onCancelBranch = (graph: TaskGraph, node: TaskGraphNode) =>
    confirm({
      title: "Cancel this branch?",
      message: `“${node.title}” and every task that depends on it stop.`,
      confirmText: "Cancel branch",
      onConfirm: () => void edit(graph, { type: "cancel_branch", key: node.key }),
    });

  const onRetry = (graph: TaskGraph, node: TaskGraphNode) => {
    void Haptics.selectionAsync();
    void edit(graph, { type: "retry_node", key: node.key });
  };

  const openNodeThread = (node: TaskGraphNode) => {
    if (node.threadId === null) return;
    void Haptics.selectionAsync();
    // Replace rather than push, like the agents sheet: the node thread belongs
    // in the workspace stack, not on top of a dismissed sheet.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: node.assignedEnvironmentId ?? target.environmentId,
        threadId: node.threadId,
      }),
    );
  };

  const openPullRequest = async (url: string) => {
    if (!(await tryOpenExternalUrl(url, "pull-request"))) {
      Alert.alert("Unable to open PR", "The pull request could not be opened.");
    }
  };

  const content = (
    <ScrollView
      className="flex-1"
      // The iOS header is translucent and floats over this view; UIKit has to
      // inset the content or the first row sits underneath the title.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-6 px-5 pt-2"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {query.error !== null && graphs === null ? (
        <Text className="pt-6 text-center text-sm text-danger-foreground">{query.error}</Text>
      ) : graphs === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">Loading task graphs…</Text>
      ) : graphs.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No task graphs on this thread.
        </Text>
      ) : (
        graphs.map((graph) => {
          const actions = taskGraphActions(graph);
          const busy = pending.has(graph.id);
          return (
            <View key={graph.id} className="gap-3">
              <View className="gap-1">
                <View className="flex-row items-center gap-2">
                  <SubagentStatusDot tone={taskGraphTone(graph.status)} placement="sheet" />
                  <Text numberOfLines={2} className="min-w-0 flex-1 font-t3-bold text-base">
                    {graph.title}
                  </Text>
                </View>
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {taskGraphSummaryLabel(graph)} · from {graph.baseRef}
                </Text>
              </View>
              {(actions.run && canRun) || (actions.cancel && canCancel) ? (
                <View className="flex-row gap-2">
                  {actions.run && canRun ? (
                    <RequestActionButton label="Run" disabled={busy} onPress={() => onRun(graph)} />
                  ) : null}
                  {actions.cancel && canCancel ? (
                    <RequestActionButton
                      label="Cancel graph"
                      tone="danger"
                      disabled={busy}
                      onPress={() => onCancel(graph)}
                    />
                  ) : null}
                </View>
              ) : null}
              {taskGraphLayers(graph.nodes).map((layer, index) => (
                <View key={layer[0]?.key ?? index} className="gap-1">
                  <Text className="text-xs font-t3-bold uppercase text-foreground-muted">
                    Step {index + 1}
                  </Text>
                  {layer.map((node) => {
                    const nodeActions = taskGraphNodeActions(graph, node);
                    return (
                      <NodeRow
                        key={node.key}
                        node={node}
                        placement={placementLabel(graph, node)}
                        busy={busy || pending.has(`${graph.id}:${node.key}`)}
                        canCancelBranch={nodeActions.cancelBranch && canEdit}
                        canRetry={nodeActions.retry && canEdit}
                        onOpen={() => openNodeThread(node)}
                        onOpenPullRequest={(url) => void openPullRequest(url)}
                        onCancelBranch={() => onCancelBranch(graph, node)}
                        onRetry={() => onRetry(graph, node)}
                      />
                    );
                  })}
                </View>
              ))}
            </View>
          );
        })
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from
    // a nested native stack inside the sheet (same shape as the agents sheet).
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-task-graphs-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={theme["--color-foreground"]}
              hideBackButton
              hideShadow={false}
              title="Task graphs"
              titleColor={theme["--color-foreground"]}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Task graphs" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}

function NodeRow(props: {
  readonly node: TaskGraphNode;
  /** Model and machine, empty when neither is known. */
  readonly placement: string;
  readonly busy: boolean;
  readonly canCancelBranch: boolean;
  readonly canRetry: boolean;
  readonly onOpen: () => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onCancelBranch: () => void;
  readonly onRetry: () => void;
}) {
  const { node } = props;
  const tone = taskGraphNodeTone(node.status);
  const pullRequestUrl = node.pullRequestResult?.url ?? null;
  const pullRequestError =
    node.pullRequestResult?.status === "failed" ? node.pullRequestResult.error : null;
  const detail = node.status === "succeeded" ? pullRequestError : (node.error ?? pullRequestError);
  // Read once: "today" versus "tomorrow" only needs to be right when the sheet opens.
  const [now] = useState(Date.now);
  const wait = taskGraphNodeWaitDetail(node, now);
  const hasActions = pullRequestUrl !== null || props.canCancelBranch || props.canRetry;

  const summary = (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <SubagentStatusDot tone={tone} placement="sheet" />
        <Text numberOfLines={2} className="min-w-0 flex-1 font-t3-medium text-sm">
          {node.title}
        </Text>
        <Text className={`shrink-0 text-xs ${SUBAGENT_TONE_TEXT_CLASS[tone]}`}>
          {taskGraphNodeStatusLabel(node.status)}
        </Text>
      </View>
      {wait !== null ? (
        <Text numberOfLines={2} className="ps-4 text-xs text-foreground-secondary">
          {wait}
        </Text>
      ) : null}
      {props.placement !== "" ? (
        <Text numberOfLines={1} className="ps-4 text-xs text-foreground-muted">
          {props.placement}
        </Text>
      ) : null}
      {node.branch !== null ? (
        <Text numberOfLines={1} className="ps-4 text-xs text-foreground-muted">
          {node.branch}
        </Text>
      ) : null}
      {detail ? (
        <Text numberOfLines={3} className="ps-4 text-xs text-foreground-secondary">
          {detail}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View className="gap-2 border-b border-border py-3">
      {node.threadId === null ? (
        <View accessible>{summary}</View>
      ) : (
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens this task's thread"
          onPress={props.onOpen}
          className="active:opacity-70"
        >
          {summary}
        </Pressable>
      )}
      {hasActions ? (
        <View className="flex-row flex-wrap gap-2 ps-4">
          {pullRequestUrl !== null ? (
            <NodeAction label="Open PR" onPress={() => props.onOpenPullRequest(pullRequestUrl)} />
          ) : null}
          {props.canRetry ? (
            <NodeAction label="Retry" disabled={props.busy} onPress={props.onRetry} />
          ) : null}
          {props.canCancelBranch ? (
            <NodeAction
              label="Cancel branch"
              disabled={props.busy}
              onPress={props.onCancelBranch}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function NodeAction(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-lg bg-subtle px-3 py-1.5 active:opacity-70 disabled:opacity-50"
    >
      <Text className="font-t3-medium text-xs text-foreground">{props.label}</Text>
    </Pressable>
  );
}

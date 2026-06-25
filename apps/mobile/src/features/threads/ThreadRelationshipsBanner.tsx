import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import { canDetachThreadProviderSession } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { buildThreadRoutePath } from "../../lib/routes";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId): string {
  if (edge.kind === "transfer") {
    return edge.sourceThreadId === currentThreadId ? "Context sent to" : "Context received from";
  }
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Forked from";
}

function relationshipSymbol(edge: ThreadRelationshipEdge): SFSymbol {
  if (edge.kind === "subagent") return "person.2";
  if (edge.kind === "transfer") return "arrow.left.arrow.right";
  return "arrow.triangle.branch";
}

function threadAvailability(
  thread: OrchestrationV2ThreadShell | null,
  missing: boolean,
): string | null {
  if (missing) return "Unavailable";
  if (thread?.deletedAt !== null && thread?.deletedAt !== undefined) return "Deleted";
  if (thread?.archivedAt !== null && thread?.archivedAt !== undefined) return "Archived";
  return null;
}

const EMPTY_THREAD_SHELLS: ReadonlyArray<OrchestrationV2ThreadShell> = [];

export function ThreadRelationshipsBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scopedProjection = useThreadProjection(props);
  const projection = scopedProjection?.projection ?? null;
  const threadShells = useThreadShells();
  const environmentIds = useMemo(() => [props.environmentId], [props.environmentId]);
  const archived = useArchivedThreadSnapshots(environmentIds);
  const archivedShells =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? EMPTY_THREAD_SHELLS;
  const shells = useMemo<ReadonlyArray<OrchestrationV2ThreadShell>>(() => {
    const environmentShells: OrchestrationV2ThreadShell[] = [];
    for (const thread of threadShells) {
      if (thread.environmentId === props.environmentId) {
        environmentShells.push(thread.source);
      }
    }
    environmentShells.push(...archivedShells);
    return environmentShells;
  }, [archivedShells, props.environmentId, threadShells]);
  const graph = useMemo(
    () => deriveThreadRelationshipGraph({ threads: shells, projection }),
    [projection, shells],
  );
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const rows = useMemo(
    () =>
      immediateThreadRelationships(graph, props.threadId).toSorted(
        (left, right) =>
          Number(right.threadId === mergeTargetThreadId) -
          Number(left.threadId === mergeTargetThreadId),
      ),
    [graph, mergeTargetThreadId, props.threadId],
  );
  const latestCompletedRun = projection?.runs.findLast((run) => run.status === "completed") ?? null;
  const canMerge = mergeTargetThreadId !== null && latestCompletedRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;
  const [visible, setVisible] = useState(false);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const router = useRouter();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const insets = useSafeAreaInsets();
  const backdropColor = useThemeColor("--color-backdrop");
  const sheetColor = useThemeColor("--color-sheet");
  const iconColor = useThemeColor("--color-icon-subtle");

  if (rows.length === 0 && !canDetach) return null;

  const primaryParent = rows.find(({ edge }) => edge.targetThreadId === props.threadId) ?? rows[0];
  const primaryNode = primaryParent ? graph.nodes.get(primaryParent.threadId) : null;
  const summary = primaryParent
    ? `${relationshipLabel(primaryParent.edge, props.threadId)}: ${primaryNode?.thread?.title ?? "related thread"}`
    : "Agent session connected";

  const openThread = (threadId: ThreadId, archivedThread: boolean) => {
    setVisible(false);
    void Haptics.selectionAsync();
    router.push(
      archivedThread
        ? "/settings/archive"
        : buildThreadRoutePath({ environmentId: props.environmentId, threadId }),
    );
  };

  const merge = async () => {
    if (!canMerge || mergeTargetThreadId === null || latestCompletedRun === null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestCompletedRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId, false);
  };

  const detach = async () => {
    if (!canDetach) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary}. Show thread relationships`}
        onPress={() => {
          void Haptics.selectionAsync();
          setVisible(true);
        }}
        className="mb-4 min-h-11 flex-row items-center gap-2 rounded-xl border border-neutral-300/60 bg-card px-3 py-2.5 dark:border-white/[0.1]"
      >
        <SymbolView
          name={primaryParent ? relationshipSymbol(primaryParent.edge) : "link"}
          size={14}
          tintColor={iconColor}
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {summary}
        </Text>
        {rows.length > 1 ? (
          <Text className="text-2xs tabular-nums text-foreground-muted">+{rows.length - 1}</Text>
        ) : null}
        <SymbolView name="chevron.right" size={12} tintColor={iconColor} type="monochrome" />
      </Pressable>

      <Modal
        transparent
        animationType="fade"
        visible={visible}
        statusBarTranslucent
        onRequestClose={() => setVisible(false)}
      >
        <View className="flex-1 justify-end">
          <View
            pointerEvents="none"
            className="absolute inset-0"
            style={{ backgroundColor: backdropColor }}
          />
          <Pressable className="absolute inset-0" onPress={() => setVisible(false)} />
          <View
            className="max-h-[78%] rounded-t-[28px] px-4 pt-3"
            style={{ backgroundColor: sheetColor, paddingBottom: Math.max(insets.bottom, 16) }}
          >
            <View className="mb-4 h-1 w-10 self-center rounded-full bg-neutral-400/40" />
            <View className="mb-3 flex-row items-center justify-between px-1">
              <View>
                <Text className="font-t3-bold text-lg text-foreground">Thread lineage</Text>
                <Text className="text-xs text-foreground-muted">
                  {rows.length} related {rows.length === 1 ? "thread" : "threads"}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close thread lineage"
                onPress={() => setVisible(false)}
                className="h-10 w-10 items-center justify-center rounded-full bg-neutral-200/70 dark:bg-white/[0.07]"
              >
                <SymbolView name="xmark" size={14} tintColor={iconColor} type="monochrome" />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
              {rows.map(({ threadId, edge }) => {
                const node = graph.nodes.get(threadId);
                const availability = threadAvailability(
                  node?.thread ?? null,
                  node?.missing ?? true,
                );
                const archivedThread = availability === "Archived";
                const disabled = availability === "Unavailable" || availability === "Deleted";
                return (
                  <Pressable
                    key={`${edge.kind}:${threadId}`}
                    accessibilityRole={disabled ? undefined : "link"}
                    accessibilityState={{ disabled }}
                    disabled={disabled}
                    onPress={() => openThread(threadId, archivedThread)}
                    className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-neutral-300/50 bg-card px-3 py-2.5 dark:border-white/[0.08]"
                  >
                    <View className="h-8 w-8 items-center justify-center rounded-full bg-neutral-200/60 dark:bg-white/[0.06]">
                      <SymbolView
                        name={relationshipSymbol(edge)}
                        size={14}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-3xs uppercase tracking-wide text-foreground-muted">
                        {relationshipLabel(edge, props.threadId)}
                      </Text>
                      <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
                        {node?.thread?.title ?? threadId}
                      </Text>
                    </View>
                    {availability ? (
                      <Text className="text-2xs text-foreground-muted">{availability}</Text>
                    ) : (
                      <SymbolView
                        name="chevron.right"
                        size={12}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>

            {canMerge || canDetach ? (
              <View className="mt-4 gap-2 border-t border-neutral-300/50 pt-4 dark:border-white/[0.08]">
                {canMerge ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={() => void merge()}
                    className="min-h-11 flex-row items-center justify-center gap-2 rounded-xl bg-primary px-3"
                  >
                    {busyAction === "merge" ? (
                      <ActivityIndicator color="white" />
                    ) : (
                      <SymbolView name="arrow.triangle.merge" size={14} tintColor="white" />
                    )}
                    <Text className="font-t3-medium text-sm text-primary-foreground">
                      Merge back to source
                    </Text>
                  </Pressable>
                ) : null}
                {canDetach ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={() => void detach()}
                    className="min-h-11 flex-row items-center justify-center gap-2 rounded-xl border border-neutral-300/60 px-3 dark:border-white/[0.1]"
                  >
                    {busyAction === "detach" ? <ActivityIndicator /> : null}
                    <Text className="font-t3-medium text-sm text-foreground">
                      Disconnect agent session
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";

export function ThreadQueueControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const scoped = useThreadProjection(props);
  const workflow = useMemo(
    () => (scoped ? deriveThreadQueueWorkflowState(scoped.projection) : null),
    [scoped],
  );
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const iconColor = useThemeColor("--color-icon-subtle");

  if (!workflow || workflow.queuedRuns.length === 0) return null;

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    await reorder({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId, beforeRunId },
    });
    setBusyRunId(null);
  };

  const steer = async (queuedRunId: RunId) => {
    if (!workflow.activeRun || !workflow.canPromoteToSteer) return;
    setBusyRunId(queuedRunId);
    void Haptics.selectionAsync();
    await promote({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        queuedRunId,
        targetRunId: workflow.activeRun.id,
      },
    });
    setBusyRunId(null);
  };

  return (
    <View className="mx-4 mb-3 overflow-hidden rounded-2xl border border-neutral-300/60 bg-card dark:border-white/[0.1]">
      <View className="flex-row items-center gap-2 border-b border-neutral-300/50 px-3 py-2 dark:border-white/[0.08]">
        <SymbolView name="list.number" size={13} tintColor={iconColor} type="monochrome" />
        <Text className="font-t3-medium text-xs text-foreground">Queue</Text>
        <Text className="ml-auto text-2xs tabular-nums text-foreground-muted">
          {workflow.queuedRuns.length}
        </Text>
      </View>
      <ScrollView style={{ maxHeight: 156 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {workflow.queuedRuns.map(({ run, text }, index) => (
          <View key={run.id} className="min-h-11 flex-row items-center gap-1.5 px-2">
            <Text className="w-5 text-right text-3xs tabular-nums text-foreground-muted">
              {index + 1}
            </Text>
            <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
              {text}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move queued message up"
              disabled={busyRunId !== null || !workflow.canReorder || index === 0}
              onPress={() => void move(run.id, workflow.queuedRuns[index - 1]?.run.id ?? null)}
              className="h-9 w-9 items-center justify-center disabled:opacity-30"
            >
              <SymbolView name="arrow.up" size={13} tintColor={iconColor} type="monochrome" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move queued message down"
              disabled={
                busyRunId !== null ||
                !workflow.canReorder ||
                index === workflow.queuedRuns.length - 1
              }
              onPress={() => void move(run.id, workflow.queuedRuns[index + 2]?.run.id ?? null)}
              className="h-9 w-9 items-center justify-center disabled:opacity-30"
            >
              <SymbolView name="arrow.down" size={13} tintColor={iconColor} type="monochrome" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Promote queued message to steer"
              disabled={busyRunId !== null || !workflow.canPromoteToSteer}
              onPress={() => void steer(run.id)}
              className="min-h-8 flex-row items-center gap-1 rounded-lg border border-neutral-300/60 px-2 disabled:opacity-30 dark:border-white/[0.1]"
            >
              <SymbolView
                name="arrow.turn.left.up"
                size={12}
                tintColor={iconColor}
                type="monochrome"
              />
              <Text className="font-t3-medium text-2xs text-foreground">Steer</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

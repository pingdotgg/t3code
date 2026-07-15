import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { SymbolView, type SFSymbol } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  LayoutAnimation,
  Pressable,
  ScrollView,
  View,
  type ColorValue,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { threadHealthStalledForLabel, type ThreadHealth } from "../../lib/threadHealth";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  SUBAGENT_TASK_MAX_VISIBLE_LOG_ENTRIES,
  hasSubagentTaskExpandableContent,
  isSubagentTaskStalled,
  subagentTaskDurationMs,
  subagentTaskIdentityBadge,
  subagentTaskLastActivityLabel,
  subagentTaskSubtitle,
  subagentTaskTitle,
  subagentTaskUsageSummary,
  type SubagentTaskItem,
  type SubagentTaskState,
} from "../../lib/subagentTaskActivity";

const ROW_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

/** 1Hz tick, but only while a row actually needs it (running tasks). */
function useLiveNow(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [enabled]);
  return nowMs;
}

function useReduceMotionEnabled(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      setReduceMotion(value);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

interface SubagentTaskColors {
  readonly muted: ColorValue;
  readonly amber: ColorValue;
  readonly emerald: ColorValue;
  readonly rose: ColorValue;
}

/** Status tints, contrast-pinned against the scenery plate the row sits on. */
function useSubagentTaskColors(): SubagentTaskColors {
  const muted = useThemeColor("--color-scenery-plate-icon");
  const amber = useThemeColor("--color-scenery-plate-warning");
  const emerald = useThemeColor("--color-scenery-plate-success");
  const rose = useThemeColor("--color-scenery-plate-danger");
  return useMemo(() => ({ muted, amber, emerald, rose }), [amber, emerald, muted, rose]);
}

function statusIconName(state: SubagentTaskState, stalled: boolean): SFSymbol {
  switch (state) {
    case "running":
      return stalled ? "exclamationmark.circle" : "circle.dotted";
    case "paused":
      return "pause.circle.fill";
    case "completed":
      return "checkmark.circle.fill";
    case "failed":
      return "xmark.circle.fill";
    case "stopped":
      return "stop.circle.fill";
  }
}

function statusIconTintColor(
  state: SubagentTaskState,
  stalled: boolean,
  colors: SubagentTaskColors,
): ColorValue {
  switch (state) {
    case "running":
      return stalled ? colors.amber : colors.muted;
    case "paused":
      return colors.muted;
    case "completed":
      return colors.emerald;
    case "failed":
      return colors.rose;
    case "stopped":
      return colors.muted;
  }
}

function rowBackgroundClassName(state: SubagentTaskState, stalled: boolean): string {
  switch (state) {
    case "running":
      return stalled ? "bg-amber-500/8" : "bg-accent-soft";
    case "paused":
      return "bg-subtle";
    case "completed":
      return "bg-emerald-500/8 dark:bg-emerald-500/10";
    case "failed":
      return "bg-rose-500/8 dark:bg-rose-500/10";
    case "stopped":
      return "bg-subtle";
  }
}

function formatOffset(startedAtMs: number, atMs: number): string {
  const seconds = Math.max(0, Math.floor((atMs - startedAtMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}:${rem.toString().padStart(2, "0")}`;
}

const RunningDurationLabel = memo(function RunningDurationLabel(props: {
  readonly startedAt: string;
}) {
  const nowMs = useLiveNow(true);
  const elapsedMs = Math.max(0, nowMs - Date.parse(props.startedAt));
  return (
    <Text
      className="text-xs text-scenery-plate-foreground-muted"
      style={{ fontVariant: ["tabular-nums"] }}
      numberOfLines={1}
    >
      {formatDuration(elapsedMs)}
    </Text>
  );
});

export const SubagentTaskRow = memo(function SubagentTaskRow(props: {
  readonly task: SubagentTaskItem;
  readonly threadHealth: ThreadHealth | null;
  readonly modelDisplayNames: ReadonlyMap<string, string>;
  readonly stopError: string | null;
  readonly stopping: boolean;
  readonly onStopAgent: () => void;
}) {
  const { task } = props;
  const [expanded, setExpanded] = useState(false);
  const isRunning = task.state === "running";
  const nowMs = useLiveNow(isRunning);
  const stalled = isSubagentTaskStalled(task, nowMs, props.threadHealth);
  const stalledForLabel =
    stalled && props.threadHealth?.stalled
      ? threadHealthStalledForLabel(props.threadHealth, nowMs)
      : null;
  const canExpand = hasSubagentTaskExpandableContent(task);
  const reduceMotion = useReduceMotionEnabled();
  const colors = useSubagentTaskColors();
  const canStop = (task.state === "running" || task.state === "paused") && !props.stopping;

  const identityBadge = subagentTaskIdentityBadge(task, props.modelDisplayNames);
  const subtitle = subagentTaskSubtitle(task);
  const usageSummary = subagentTaskUsageSummary(task.usage);
  const durationMs = subagentTaskDurationMs(task);

  const visibleLog = useMemo(
    () => task.progressLog.slice(-SUBAGENT_TASK_MAX_VISIBLE_LOG_ENTRIES),
    [task.progressLog],
  );
  const hiddenLogCount = task.progressLog.length - visibleLog.length;
  const startedAtMs = useMemo(() => Date.parse(task.startedAt), [task.startedAt]);

  return (
    // The state tint is translucent, so on the chat wallpaper it would leave
    // the row's text on the photo. The tint rides on a scenery plate, which
    // bounds the backdrop the row's small type is read against.
    <View
      collapsable={false}
      className="mb-1.5 rounded-2xl bg-scenery-plate"
      style={{ borderCurve: "continuous" }}
    >
      <View
        className={cn("gap-1 rounded-2xl px-2.5 py-2", rowBackgroundClassName(task.state, stalled))}
        style={{ borderCurve: "continuous" }}
      >
        <Pressable
          accessibilityRole={canExpand ? "button" : undefined}
          accessibilityLabel={
            stalled
              ? `${subagentTaskTitle(task)}, stalled — no recent activity`
              : subagentTaskTitle(task)
          }
          accessibilityState={canExpand ? { expanded } : undefined}
          disabled={!canExpand}
          hitSlop={4}
          onPress={() => {
            if (!canExpand) return;
            if (!reduceMotion) {
              LayoutAnimation.configureNext(ROW_LAYOUT_ANIMATION);
            }
            void Haptics.selectionAsync();
            setExpanded((value) => !value);
          }}
        >
          <View className="flex-row items-start gap-2">
            <View className="h-4 w-4 items-center justify-center pt-0.5">
              <SymbolView
                name={statusIconName(task.state, stalled)}
                size={15}
                tintColor={statusIconTintColor(task.state, stalled, colors)}
                type="monochrome"
                resizeMode="center"
              />
            </View>

            <View className="min-w-0 flex-1 gap-1">
              <View className="flex-row items-start gap-1.5">
                <View className="h-[15px] w-3.5 items-center justify-center pt-0.5">
                  <SymbolView
                    name="person.2"
                    size={12}
                    type="monochrome"
                    tintColor={colors.muted}
                  />
                </View>
                <Text
                  className="min-w-0 flex-1 font-t3-medium text-sm text-scenery-plate-foreground"
                  numberOfLines={2}
                >
                  {subagentTaskTitle(task)}
                </Text>
                {canStop ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Stop agent"
                    hitSlop={8}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      props.onStopAgent();
                    }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                  >
                    <SymbolView
                      name="stop.circle"
                      size={15}
                      type="monochrome"
                      tintColor={colors.muted}
                    />
                  </Pressable>
                ) : null}
                {isRunning ? (
                  <RunningDurationLabel startedAt={task.startedAt} />
                ) : durationMs !== null ? (
                  <Text
                    className="text-xs text-scenery-plate-foreground-muted"
                    style={{ fontVariant: ["tabular-nums"] }}
                  >
                    {formatDuration(durationMs)}
                  </Text>
                ) : null}
                {canExpand ? (
                  <View className="h-[15px] w-3 items-center justify-center">
                    <SymbolView
                      name={expanded ? "chevron.down" : "chevron.right"}
                      size={10}
                      type="monochrome"
                      tintColor={colors.muted}
                    />
                  </View>
                ) : null}
              </View>

              {identityBadge ? (
                <Text
                  className="font-t3-medium text-2xs text-scenery-plate-foreground-muted"
                  numberOfLines={1}
                >
                  {identityBadge}
                </Text>
              ) : null}

              <View className="flex-row flex-wrap items-center gap-1.5">
                {task.state === "running" ? (
                  <>
                    <Text
                      className={cn(
                        "text-3xs",
                        stalled
                          ? "text-scenery-plate-warning"
                          : "text-scenery-plate-foreground-muted",
                      )}
                    >
                      {stalledForLabel ?? subagentTaskLastActivityLabel(task, nowMs)}
                    </Text>
                    {stalled ? (
                      <StatusPill
                        size="compact"
                        label="stalled"
                        pillClassName="bg-amber-500/14"
                        textClassName="text-scenery-plate-warning"
                      />
                    ) : null}
                    {task.isBackgrounded ? (
                      <StatusPill
                        size="compact"
                        label="background"
                        pillClassName="bg-subtle-strong"
                        textClassName="text-scenery-plate-foreground-muted"
                      />
                    ) : null}
                  </>
                ) : task.state === "paused" ? (
                  <>
                    <StatusPill
                      size="compact"
                      label="paused"
                      pillClassName="bg-subtle-strong"
                      textClassName="text-scenery-plate-foreground-muted"
                    />
                    {task.isBackgrounded ? (
                      <StatusPill
                        size="compact"
                        label="background"
                        pillClassName="bg-subtle-strong"
                        textClassName="text-scenery-plate-foreground-muted"
                      />
                    ) : null}
                  </>
                ) : task.isBackgrounded ? (
                  <StatusPill
                    size="compact"
                    label="background"
                    pillClassName="bg-subtle-strong"
                    textClassName="text-scenery-plate-foreground-muted"
                  />
                ) : null}
              </View>

              {subtitle ? (
                <Text className="text-xs text-scenery-plate-foreground-muted" numberOfLines={2}>
                  {subtitle}
                </Text>
              ) : null}

              {props.stopError ? (
                <Text selectable className="text-xs text-scenery-plate-danger">
                  {props.stopError}
                </Text>
              ) : null}
            </View>
          </View>
        </Pressable>

        {expanded && canExpand ? (
          <View className="ml-[27px] gap-1.5 pt-0.5">
            {task.lastToolName ? (
              <View className="flex-row gap-1.5">
                <Text className="font-t3-medium text-3xs text-scenery-plate-foreground-muted">
                  Last tool
                </Text>
                <Text
                  className="flex-1 text-xs text-scenery-plate-foreground-muted"
                  numberOfLines={2}
                >
                  {task.lastToolName}
                </Text>
              </View>
            ) : null}
            {usageSummary ? (
              <View className="flex-row gap-1.5">
                <Text className="font-t3-medium text-3xs text-scenery-plate-foreground-muted">
                  Usage
                </Text>
                <Text
                  className="flex-1 text-xs text-scenery-plate-foreground-muted"
                  numberOfLines={2}
                >
                  {usageSummary}
                </Text>
              </View>
            ) : null}
            {task.error ? (
              <Text selectable className="text-xs text-scenery-plate-danger">
                {task.error}
              </Text>
            ) : null}
            {visibleLog.length > 0 ? (
              <View className="border-l border-neutral-300/60 pl-2.5 dark:border-white/[0.12]">
                {hiddenLogCount > 0 ? (
                  <Text className="pb-0.5 text-3xs text-scenery-plate-foreground-muted">
                    … {hiddenLogCount} earlier update{hiddenLogCount === 1 ? "" : "s"}
                  </Text>
                ) : null}
                <ScrollView
                  nestedScrollEnabled
                  directionalLockEnabled
                  showsVerticalScrollIndicator
                  style={{ maxHeight: 220 }}
                  contentContainerStyle={{ gap: 3 }}
                >
                  {visibleLog.map((entry, index) => {
                    const emphasize = isRunning && index === visibleLog.length - 1;
                    return (
                      <Text
                        key={`${entry.at}:${entry.toolName ?? ""}:${entry.text}`}
                        selectable
                        className={cn(
                          "text-2xs leading-normal",
                          emphasize
                            ? "text-scenery-plate-foreground"
                            : "text-scenery-plate-foreground-muted",
                        )}
                      >
                        <Text
                          className="text-scenery-plate-foreground-muted"
                          style={{ fontFamily: "ui-monospace" }}
                        >
                          {formatOffset(startedAtMs, Date.parse(entry.at))}
                        </Text>
                        {entry.toolName ? (
                          <Text className="font-t3-medium text-scenery-plate-foreground-muted">{`  ${entry.toolName}`}</Text>
                        ) : null}
                        {`  ${entry.text}`}
                      </Text>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
});

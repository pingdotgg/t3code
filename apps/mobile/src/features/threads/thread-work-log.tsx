import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { LayoutAnimation, Pressable, useColorScheme, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { T3_CODE_BRAND_MARK_SOURCE } from "../../components/brandAssets";
import { cn } from "../../lib/cn";
import { threadFeedActivityIsVisible, type ThreadFeedActivity } from "../../lib/threadActivity";
import Animated, { FadeIn } from "react-native-reanimated";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { ThreadActivityInspector } from "./ThreadActivityInspector";
import {
  resolveThreadActivityMetadata,
  resolveThreadActivityStatus,
} from "./thread-activity-row-presentation";
import { threadWorkLogOverflowNoun } from "./thread-work-log-labels";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
const WORK_LOG_LAYOUT_ANIMATION = {
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

function triggerDisclosureFeedback() {
  LayoutAnimation.configureNext(WORK_LOG_LAYOUT_ANIMATION);
  void Haptics.selectionAsync();
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

function WorkRowIcon(props: {
  readonly row: ThreadFeedActivity;
  readonly iconSubtleColor: import("react-native").ColorValue;
}) {
  const iconIsDestructive = props.row.icon === "alert" || props.row.icon === "warning";
  if (props.row.logo === "t3-code") {
    return (
      <Image
        source={T3_CODE_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
        }}
      />
    );
  }

  return (
    <SymbolView
      name={workRowSymbolName(props.row.icon)}
      size={14}
      weight="medium"
      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
      type="monochrome"
    />
  );
}

function ThreadActivityThreadRow(props: {
  readonly activity: ThreadFeedActivity;
  readonly environmentId: EnvironmentId;
  readonly iconColor: import("react-native").ColorValue;
}) {
  const row = props.activity.projectedItem;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
  });
  const navigation = useNavigation();
  const item = row.item;
  let targetThreadId: ThreadId | null = null;
  let label = "Open related thread";
  let providerDriver = support.providerSession?.driver ?? null;
  let providerInstanceId = support.providerSession?.providerInstanceId ?? null;
  let model = support.providerSession?.model ?? null;

  if (item.type === "thread_created") {
    targetThreadId = item.targetThreadId;
    label = "Open created thread";
    providerInstanceId = item.targetProviderInstanceId;
    model = item.targetModel;
  } else if (item.type === "subagent") {
    targetThreadId = support.subagent?.childThreadId ?? item.childThreadId;
    label = "Open subagent thread";
    providerDriver = support.subagent?.driver ?? item.driver;
    providerInstanceId = support.subagent?.providerInstanceId ?? item.providerInstanceId;
    model = support.subagent?.model ?? model;
  } else if (item.type === "fork") {
    targetThreadId =
      item.targetThreadId === row.sourceThreadId && item.source.type === "run"
        ? item.source.threadId
        : item.targetThreadId;
    label = targetThreadId === item.targetThreadId ? "Open forked thread" : "Open parent thread";
  }

  const metadata = resolveThreadActivityMetadata({ providerDriver, providerInstanceId, model });
  const status = resolveThreadActivityStatus(item.status);
  const statusDotClassName =
    status.tone === "success"
      ? "bg-emerald-500"
      : status.tone === "danger"
        ? "bg-rose-500"
        : status.tone === "warning"
          ? "bg-amber-500"
          : "bg-sky-500";

  return (
    <View className="mb-2 min-h-11 flex-row items-center gap-2 rounded-xl border border-continuous border-neutral-950/10 bg-card px-2.5 py-1.5 dark:border-white/10">
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={status.label}
        className={cn("size-2 shrink-0 rounded-full", statusDotClassName)}
      />

      <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        <Text className="font-t3-medium text-foreground">{props.activity.summary}</Text>
        {metadata ? <Text className="text-foreground-muted opacity-60"> · {metadata}</Text> : null}
      </Text>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel={label}
        disabled={targetThreadId === null}
        hitSlop={10}
        onPress={() => {
          if (targetThreadId === null) return;
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: targetThreadId,
          });
        }}
        className="h-8 shrink-0 flex-row items-center gap-1 rounded-lg bg-neutral-950/5 py-1.5 pl-2.5 pr-1.5 active:bg-neutral-950/10 disabled:opacity-40 dark:bg-white/5 dark:active:bg-white/10"
      >
        <Text className="font-t3-medium text-sm text-foreground">Open</Text>
        <SymbolView name="arrow.right" size={11} tintColor={props.iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Routine neutral tool activity carries no signal worth a row. Prominent
// linked activity stays visible so its live status and thread affordance do.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter(threadFeedActivityIsVisible);
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly currentThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly expanded: boolean;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleGroup: () => void;
  readonly onToggleRow: (rowId: string) => void;
  readonly workspaceRoot?: string | null;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows =
    hasOverflow && !props.expanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const onlyToolRows = rows.every((row) => row.toolLike);
  const overflowNoun = threadWorkLogOverflowNoun(onlyToolRows, hiddenCount);

  return (
    <View className="-mx-1 mb-3 px-1 py-0.5">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {visibleRows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          const detail = compactActivityDetail(row.detail);
          const displayText = detail ? `${row.summary} ${detail}` : row.summary;
          const textIsDestructive = row.icon === "alert" || row.icon === "warning";

          if (row.prominent) {
            return (
              <Animated.View
                key={row.id}
                {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
              >
                <ThreadActivityThreadRow
                  activity={row}
                  environmentId={props.environmentId}
                  iconColor={props.iconSubtleColor}
                />
              </Animated.View>
            );
          }

          return (
            <Animated.View
              key={row.id}
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    triggerDisclosureFeedback();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0.5"
              >
                <View className="min-h-9 flex-row items-center gap-1.5">
                  <View className="h-5 w-5 shrink-0 items-center justify-center">
                    <WorkRowIcon row={row} iconSubtleColor={props.iconSubtleColor} />
                  </View>

                  <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                    <Text
                      className={cn(
                        "font-t3-medium text-foreground",
                        textIsDestructive && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {row.summary}
                    </Text>
                    {detail ? (
                      <Text className="text-foreground-muted opacity-60"> {detail}</Text>
                    ) : null}
                  </Text>

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                    <View className="h-4 w-4 items-center justify-center">
                      {row.status ? (
                        <SymbolView
                          name={
                            row.status === "failure"
                              ? { ios: "xmark", android: "close" }
                              : row.status === "success"
                                ? { ios: "checkmark", android: "check" }
                                : { ios: "minus", android: "remove" }
                          }
                          size={11}
                          tintColor={row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {expanded && canExpand ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1.5 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ThreadActivityInspector
                    activity={row}
                    currentThreadId={props.currentThreadId}
                    environmentId={props.environmentId}
                    iconColor={props.iconSubtleColor}
                    workspaceRoot={props.workspaceRoot}
                  />
                </View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>

      {hasOverflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          accessibilityLabel={
            props.expanded
              ? `Show fewer ${overflowNoun}`
              : `Show ${hiddenCount} previous ${overflowNoun}`
          }
          hitSlop={4}
          onPress={() => {
            triggerDisclosureFeedback();
            props.onToggleGroup();
          }}
          style={({ pressed }) => ({
            backgroundColor: pressed ? pressedBackground : "transparent",
          })}
          className="min-h-9 flex-row items-center gap-1.5 rounded-md px-0.5 py-0.5"
        >
          <View className="h-5 w-5 items-center justify-center">
            <SymbolView
              name={props.expanded ? "chevron.up" : "chevron.down"}
              size={13}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
          </View>
          <Text className="font-t3-medium text-xs text-foreground opacity-80">
            {props.expanded
              ? `Show fewer ${overflowNoun}`
              : `+${hiddenCount} previous ${overflowNoun}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onlyToolActivities: boolean;
  readonly onToggle: () => void;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const noun = threadWorkLogOverflowNoun(props.onlyToolActivities, props.hiddenCount);

  return (
    <View className="-mx-1 mb-1 px-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={
          props.expanded ? `Show fewer ${noun}` : `Show ${props.hiddenCount} previous ${noun}`
        }
        hitSlop={4}
        onPress={() => {
          triggerDisclosureFeedback();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={props.expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? `Show fewer ${noun}` : `+${props.hiddenCount} previous ${noun}`}
        </Text>
      </Pressable>
    </View>
  );
}

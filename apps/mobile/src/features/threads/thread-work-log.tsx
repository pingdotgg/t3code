import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRouter } from "expo-router";
import { LayoutAnimation, Pressable, useColorScheme, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { buildThreadRoutePath } from "../../lib/routes";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { ThreadActivityInspector } from "./ThreadActivityInspector";

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

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): SFSymbol {
  switch (icon) {
    case "agent":
      return "sparkles";
    case "alert":
      return "exclamationmark.triangle";
    case "check":
      return "checkmark";
    case "command":
      return "terminal";
    case "edit":
      return "square.and.pencil";
    case "eye":
      return "eye";
    case "globe":
      return "globe";
    case "hammer":
      return "hammer";
    case "message":
      return "bubble.left";
    case "warning":
      return "xmark";
    case "wrench":
      return "wrench";
    case "zap":
      return "bolt";
  }
}

function ThreadActivityThreadLink(props: {
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
  const router = useRouter();
  const item = row.item;
  let targetThreadId: ThreadId | null = null;
  let label = "Open related thread";

  if (item.type === "thread_created") {
    targetThreadId = item.targetThreadId;
    label = "Open created thread";
  } else if (item.type === "subagent") {
    targetThreadId = support.subagent?.childThreadId ?? item.childThreadId;
    label = "Open subagent thread";
  } else if (item.type === "fork") {
    targetThreadId =
      item.targetThreadId === row.sourceThreadId && item.source.type === "run"
        ? item.source.threadId
        : item.targetThreadId;
    label = targetThreadId === item.targetThreadId ? "Open forked thread" : "Open parent thread";
  }

  if (targetThreadId === null) return null;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync();
        router.push(
          buildThreadRoutePath({
            environmentId: props.environmentId,
            threadId: targetThreadId,
          }),
        );
      }}
      className="mx-2 mb-2 min-h-9 flex-row items-center justify-center gap-1.5 rounded-lg border border-neutral-300/50 px-2 dark:border-white/[0.08]"
    >
      <Text className="font-t3-medium text-2xs text-foreground">{label}</Text>
      <SymbolView name="arrow.right" size={11} tintColor={props.iconColor} type="monochrome" />
    </Pressable>
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
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
  const rows = props.activities;

  if (rows.length === 0) {
    return null;
  }

  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows =
    hasOverflow && !props.expanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const onlyToolRows = rows.every((row) => row.toolLike);

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
          const canExpand = row.fullDetail !== null;
          const detail = compactActivityDetail(row.detail);
          const displayText = detail ? `${row.summary} ${detail}` : row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";

          return (
            <View
              key={row.id}
              className={cn(
                row.prominent &&
                  "mb-2 overflow-hidden rounded-xl border border-neutral-300/60 bg-card dark:border-white/[0.1]",
              )}
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
                onLongPress={() => props.onCopyRow(row.id, row.copyText)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0.5"
              >
                <View className="min-h-9 flex-row items-center gap-1.5">
                  <View className="h-5 w-5 shrink-0 items-center justify-center">
                    <SymbolView
                      name={workRowSymbolName(row.icon)}
                      size={14}
                      weight="medium"
                      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                      type="monochrome"
                    />
                  </View>

                  <Text
                    className="min-w-0 flex-1 text-xs leading-5 text-foreground"
                    numberOfLines={1}
                  >
                    <Text
                      className={cn(
                        "font-t3-medium text-foreground",
                        iconIsDestructive && "text-rose-600 dark:text-rose-400",
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
                          name={expanded ? "chevron.up" : "chevron.down"}
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
                              ? "xmark"
                              : row.status === "success"
                                ? "checkmark"
                                : "minus"
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

              {expanded && row.fullDetail ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1.5 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ThreadActivityInspector
                    activity={row}
                    environmentId={props.environmentId}
                    iconColor={props.iconSubtleColor}
                    workspaceRoot={props.workspaceRoot}
                  />
                </View>
              ) : null}
              {row.prominent ? (
                <ThreadActivityThreadLink
                  activity={row}
                  environmentId={props.environmentId}
                  iconColor={props.iconSubtleColor}
                />
              ) : null}
            </View>
          );
        })}
      </View>

      {hasOverflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          accessibilityLabel={
            props.expanded
              ? "Show fewer tool calls"
              : `Show ${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`
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
              ? "Show fewer tool calls"
              : `+${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

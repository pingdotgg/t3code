import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { LayoutAnimation, Pressable, ScrollView, useColorScheme, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import Animated, { FadeIn } from "react-native-reanimated";

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

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): SymbolViewProps["name"] {
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

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const rows = props.activities
    .filter((activity) => !(activity.toolLike && activity.status === "neutral"))
    .map((activity) => ({ ...activity, detail: compactActivityDetail(activity.detail) }));

  if (rows.length === 0) {
    return null;
  }

  const onlyToolRows = rows.every((row) => row.toolLike);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {rows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.fullDetail !== null;
          const displayText = row.detail ? `${row.summary} ${row.detail}` : row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";

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
                onLongPress={() => props.onCopyRow(row.id, row.copyText)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  <View className="h-[18px] w-5 shrink-0 items-center justify-center">
                    <SymbolView
                      name={workRowSymbolName(row.icon)}
                      size={13}
                      weight="medium"
                      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                      type="monochrome"
                    />
                  </View>

                  <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                    <Text
                      className={cn(
                        "font-t3-medium text-foreground",
                        iconIsDestructive && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {row.summary}
                    </Text>
                    {row.detail ? (
                      <Text className="text-foreground-muted opacity-60"> {row.detail}</Text>
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

              {expanded && row.fullDetail ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ScrollView
                    nestedScrollEnabled
                    directionalLockEnabled
                    showsVerticalScrollIndicator
                    style={{ maxHeight: 240 }}
                    contentContainerStyle={{ paddingRight: 8 }}
                  >
                    <Text
                      selectable
                      className="text-2xs leading-normal text-foreground-muted"
                      style={{ fontFamily: "ui-monospace" }}
                    >
                      {row.fullDetail}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
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
  const noun = props.onlyToolActivities
    ? props.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : props.hiddenCount === 1
      ? "log entry"
      : "log entries";
  const collapsedLabel = `Show ${props.hiddenCount} previous ${noun}`;
  const expandedLabel = props.onlyToolActivities
    ? "Show fewer tool calls"
    : "Show fewer log entries";

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={props.expanded ? expandedLabel : collapsedLabel}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={
              props.expanded
                ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                : { ios: "chevron.down", android: "keyboard_arrow_down" }
            }
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? expandedLabel : `+${props.hiddenCount} previous ${noun}`}
        </Text>
      </Pressable>
    </View>
  );
}

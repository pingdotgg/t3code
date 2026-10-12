import { memo } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import type { ControlPillMenuProps } from "../../components/ControlPillMenu.types";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
} from "../threads/thread-list-v2-row-appearance";
import { PullRequestAvatar, PullRequestDiffStats } from "./PullRequestPresentation";
import {
  pullRequestLabelColor,
  pullRequestListReviewStatus,
  pullRequestListRowsAreEqual,
  type EnvironmentPullRequestListEntry,
} from "./pullRequestList";
import { pullRequestStatus } from "./pullRequestStatus";

export const PullRequestListRow = memo(
  function PullRequestListRow(props: {
    readonly item: EnvironmentPullRequestListEntry;
    readonly onSelect: (item: EnvironmentPullRequestListEntry) => void;
    readonly selected: boolean;
    readonly sidebar: boolean;
    readonly busy: boolean;
    readonly getActions: (item: EnvironmentPullRequestListEntry) => ControlPillMenuProps["actions"];
    readonly onAction: (item: EnvironmentPullRequestListEntry, action: string) => void;
  }) {
    const { item } = props;
    const foreground = props.selected
      ? selectedThreadRowColors.foregroundClassName
      : props.sidebar
        ? "text-drawer-foreground"
        : "text-foreground";
    const mutedForeground = props.selected
      ? selectedThreadRowColors.mutedForegroundClassName
      : props.sidebar
        ? "text-drawer-foreground-muted"
        : "text-foreground-muted";
    const tertiaryForeground = props.selected
      ? selectedThreadRowColors.mutedForegroundClassName
      : props.sidebar
        ? "text-drawer-foreground-muted"
        : "text-foreground-tertiary";
    const status = pullRequestStatus(item);
    const review = pullRequestListReviewStatus(item);
    const checkTint =
      item.checksState === "passing"
        ? "accent-adaptive-emerald-600-400"
        : item.checksState === "failing"
          ? "accent-danger-foreground"
          : "accent-warning-foreground";
    return (
      <View style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE : undefined}>
        <ControlPillMenu
          shouldOpenOnLongPress
          title={`#${item.number} · ${item.repository}`}
          actions={props.getActions(item)}
          onPressAction={({ nativeEvent }) => props.onAction(item, nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected, busy: props.busy }}
            accessibilityLabel={`Pull request ${item.number}, ${item.title}, ${status.label}, by ${item.author?.login ?? "unknown author"}${review ? `, ${review.accessibleLabel}` : ""}${item.checksState ? `, checks ${item.checksState}` : ""}${item.stack ? `, stack ${item.stack.position} of ${item.stack.size}` : ""}${item.labels.length ? `, ${item.labels.map((label) => label.name).join(", ")}` : ""}, ${item.additions} additions, ${item.deletions} deletions`}
            accessibilityHint="Double tap to open. Touch and hold for quick actions."
            onPress={() => props.onSelect(item)}
            disabled={props.busy}
            style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined}
            className={cn(
              "flex-row gap-3 overflow-hidden",
              !props.sidebar && "px-4 active:bg-row-hover",
              props.sidebar && "bg-drawer",
              props.sidebar && !props.selected && "active:bg-thread-hover",
              props.selected && "bg-thread-selected",
              props.busy && "opacity-50",
            )}
          >
            <View className={props.sidebar ? "pt-0.5" : "pt-2.5"}>
              <SymbolView name={status.icon} size={20} tintColorClassName={status.tint} />
            </View>
            <View
              className={cn(
                "min-w-0 flex-1 gap-1",
                !props.sidebar && "border-b border-border-subtle py-2.5",
              )}
            >
              <View className="flex-row items-center gap-1.5">
                <PullRequestAvatar actor={item.author} size={16} />
                <Text className={cn("min-w-0 flex-1 text-xs", mutedForeground)} numberOfLines={1}>
                  {item.repository} <Text className={tertiaryForeground}>#{item.number}</Text>
                </Text>
                {item.stack ? (
                  <View className="flex-row items-center gap-1">
                    <SymbolView
                      name="square.3.layers.3d"
                      size={12}
                      tintColorClassName={
                        props.selected
                          ? selectedThreadRowColors.mutedIconTintClassName
                          : props.sidebar
                            ? "accent-drawer-foreground-muted"
                            : "accent-foreground-muted"
                      }
                    />
                    <Text className={cn("text-2xs tabular-nums", mutedForeground)}>
                      {item.stack.position}/{item.stack.size}
                    </Text>
                  </View>
                ) : null}
                <Text className={cn("text-2xs tabular-nums", tertiaryForeground)}>
                  {relativeTime(item.updatedAt)}
                </Text>
              </View>
              <Text
                className={cn("text-base leading-5 font-t3-medium", foreground)}
                numberOfLines={2}
                ellipsizeMode="tail"
              >
                {item.title}
              </Text>
              <View className="flex-row items-center gap-1.5">
                <View className="min-w-0 flex-1 flex-row items-center gap-1">
                  {item.labels.slice(0, 2).map((label) => {
                    const color = pullRequestLabelColor(label.color);
                    return (
                      <View
                        key={label.name}
                        className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
                        style={{
                          maxWidth: 160,
                          ...(color ? { backgroundColor: `${color}20` } : {}),
                        }}
                      >
                        {color ? (
                          <View
                            style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }}
                          />
                        ) : null}
                        <Text
                          className={cn("shrink text-2xs font-t3-medium", mutedForeground)}
                          numberOfLines={1}
                        >
                          {label.name}
                        </Text>
                      </View>
                    );
                  })}
                  {item.labels.length > 2 ? (
                    <Text className={cn("shrink-0 text-2xs", tertiaryForeground)}>
                      +{item.labels.length - 2}
                    </Text>
                  ) : null}
                </View>
                {item.checksState ? (
                  <View className="shrink-0" accessibilityLabel={`Checks ${item.checksState}`}>
                    <SymbolView
                      name={
                        item.checksState === "passing"
                          ? "checkmark.circle"
                          : item.checksState === "failing"
                            ? "xmark.circle.fill"
                            : "clock"
                      }
                      size={13}
                      tintColorClassName={checkTint}
                    />
                  </View>
                ) : null}
                {review ? (
                  <View className="shrink-0" accessibilityLabel={review.accessibleLabel}>
                    <SymbolView name={review.icon} size={13} tintColorClassName={review.tint} />
                  </View>
                ) : null}
                {item.additions || item.deletions ? (
                  <PullRequestDiffStats
                    additions={item.additions}
                    deletions={item.deletions}
                    compact
                  />
                ) : null}
              </View>
            </View>
          </Pressable>
        </ControlPillMenu>
      </View>
    );
  },
  (previous, next) =>
    pullRequestListRowsAreEqual(previous.item, next.item) &&
    previous.selected === next.selected &&
    previous.sidebar === next.sidebar &&
    previous.busy === next.busy &&
    previous.onSelect === next.onSelect &&
    previous.onAction === next.onAction &&
    previous.getActions === next.getActions,
);

import * as Clipboard from "expo-clipboard";
import { memo } from "react";
import { Linking, Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
} from "../threads/thread-list-v2-row-appearance";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import type { EnvironmentIssueEntry } from "./issueList";
import { issueStatus } from "./issueStatus";

const ACTIONS = [
  {
    id: "open",
    title: "Open in browser",
    image: Platform.OS === "ios" ? "arrow.up.right" : "open_in_new",
  },
  { id: "copy", title: "Copy link", image: Platform.OS === "ios" ? "doc.on.doc" : "content_copy" },
];

export const IssueListRow = memo(function IssueListRow(props: {
  readonly item: EnvironmentIssueEntry;
  readonly onSelect: (item: EnvironmentIssueEntry) => void;
  readonly selected: boolean;
  readonly sidebar: boolean;
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
  const mutedIcon = props.selected
    ? selectedThreadRowColors.mutedIconTintClassName
    : props.sidebar
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted";
  const status = issueStatus(item.state);
  const assignee = item.assignees[0] ?? null;
  return (
    <View style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE : undefined}>
      <ControlPillMenu
        shouldOpenOnLongPress
        title={`${item.displayKey} · ${item.scope}`}
        actions={ACTIONS}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "open") void Linking.openURL(item.url);
          if (nativeEvent.event === "copy") void Clipboard.setStringAsync(item.url);
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: props.selected }}
          accessibilityLabel={`Issue ${item.displayKey}, ${item.title}, ${status.label}, by ${item.author?.login ?? "unknown author"}${item.assignees.length ? `, assigned to ${item.assignees.map((actor) => actor.name ?? actor.login).join(", ")}` : ""}${item.labels.length ? `, ${item.labels.map((label) => label.name).join(", ")}` : ""}${item.commentCount ? `, ${item.commentCount} comments` : ""}`}
          accessibilityHint="Double tap to open. Touch and hold for quick actions."
          onPress={() => props.onSelect(item)}
          style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_STYLE : undefined}
          className={cn(
            "flex-row gap-3 overflow-hidden",
            !props.sidebar && "px-4 active:bg-row-hover",
            props.sidebar && "bg-drawer",
            props.sidebar && !props.selected && "active:bg-thread-hover",
            props.selected && "bg-thread-selected",
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
                {item.scope} <Text className={tertiaryForeground}>{item.displayKey}</Text>
              </Text>
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
                <Text
                  className={cn("max-w-[120px] shrink-0 text-2xs font-t3-medium", status.text)}
                  numberOfLines={1}
                >
                  {status.label}
                </Text>
                {item.labels.slice(0, 2).map((label) => {
                  const color = pullRequestLabelColor(label.color);
                  return (
                    <View
                      key={label.name}
                      className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
                      style={{
                        maxWidth: 140,
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
              {item.commentCount ? (
                <View className="shrink-0 flex-row items-center gap-1">
                  <SymbolView name="text.bubble" size={12} tintColorClassName={mutedIcon} />
                  <Text className={cn("text-2xs tabular-nums", mutedForeground)}>
                    {item.commentCount}
                  </Text>
                </View>
              ) : null}
              {assignee ? <PullRequestAvatar actor={assignee} size={16} /> : null}
            </View>
          </View>
        </Pressable>
      </ControlPillMenu>
    </View>
  );
});

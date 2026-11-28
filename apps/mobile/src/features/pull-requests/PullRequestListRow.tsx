import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import { useGT, useMessages } from "gt-react-native";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { MenuProps } from "../../components/ui/Menu.types";
import { cn } from "../../lib/cn";
import { RelativeTime } from "../../components/RelativeTime";
import {
  selectedThreadRowColors,
  THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
  THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
} from "../threads/thread-list-v2-row-appearance";
import {
  PullRequestAvatar,
  PullRequestProjectMedia,
  PullRequestConflictBadge,
  PullRequestDiffStats,
} from "./PullRequestPresentation";
import {
  pullRequestLabelColor,
  pullRequestListDiffStatsLabel,
  pullRequestListReviewStatus,
  pullRequestListRowsAreEqual,
  type EnvironmentPullRequestListEntry,
} from "./pullRequestList";
import {
  pullRequestChecksStatus,
  pullRequestConflict,
  pullRequestStatus,
} from "./pullRequestStatus";
import { PullRequestGlyph } from "./pullRequestGlyphs";

/** A label as list rows show it: small, tinted by its color, truncating. */
export function ListRowLabel(props: {
  readonly label: { readonly name: string; readonly color: string | null };
  readonly textClassName: string;
}) {
  const color = pullRequestLabelColor(props.label.color);
  return (
    <View
      className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
      style={{ maxWidth: 160, ...(color ? { backgroundColor: `${color}20` } : {}) }}
    >
      {color ? (
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
      ) : null}
      <Text className={cn("shrink text-2xs font-t3-medium", props.textClassName)} numberOfLines={1}>
        {props.label.name}
      </Text>
    </View>
  );
}

export const PullRequestListRow = memo(
  function PullRequestListRow(props: {
    readonly item: EnvironmentPullRequestListEntry;
    readonly onSelect: (item: EnvironmentPullRequestListEntry) => void;
    readonly selected: boolean;
    readonly sidebar: boolean;
    readonly busy: boolean;
    readonly getActions: (item: EnvironmentPullRequestListEntry) => MenuProps["actions"];
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
    const gt = useGT();
    const m = useMessages();
    const status = pullRequestStatus(item, m);
    const conflict = pullRequestConflict(item, m);
    const review = pullRequestListReviewStatus(item, m);
    const checksSpoken = item.checksState
      ? {
          passing: gt("checks passing"),
          failing: gt("checks failing"),
          pending: gt("checks pending"),
        }[item.checksState]
      : null;
    const checksLabel = item.checksState
      ? {
          passing: gt("Checks passing"),
          failing: gt("Checks failing"),
          pending: gt("Checks pending"),
        }[item.checksState]
      : undefined;
    const checks = item.checksState ? pullRequestChecksStatus(item.checksState) : null;
    return (
      <View style={props.sidebar ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE : undefined}>
        <Menu
          shouldOpenOnLongPress
          title={`#${item.number} · ${item.repository}`}
          actions={props.getActions(item)}
          onPressAction={({ nativeEvent }) => props.onAction(item, nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected, busy: props.busy }}
            accessibilityLabel={[
              gt(
                "{term, select, mr {Merge request} cr {Change request} other {Pull request}} {number}",
                {
                  term: changeRequestTermKind(
                    sourceControlClients.get(item.provider).changeRequest,
                  ),
                  number: item.number,
                },
              ),
              item.title,
              status.label,
              item.visibility === "private" ? gt("Private") : null,
              conflict ? conflict.label.toLowerCase() : null,
              gt("by {author}", { author: item.author?.login ?? gt("unknown author") }),
              review ? review.accessibleLabel : null,
              checksSpoken,
              item.stack
                ? gt("stack {position} of {size}", {
                    position: item.stack.position,
                    size: item.stack.size,
                  })
                : null,
              item.labels.length ? item.labels.map((label) => label.name).join(", ") : null,
              pullRequestListDiffStatsLabel(item, m),
            ]
              .filter((part) => part !== null)
              .join(", ")}
            accessibilityHint={gt("Double tap to open. Touch and hold for quick actions.")}
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
            <View className={cn("self-start", props.sidebar ? "pt-0.5" : "pt-2.5")}>
              <SymbolView name={status.icon} size={20} tintColorClassName={status.tint} />
              {conflict ? (
                <PullRequestConflictBadge
                  surfaceClassName={
                    props.selected
                      ? "text-thread-selected"
                      : props.sidebar
                        ? "text-drawer"
                        : "text-screen"
                  }
                />
              ) : null}
            </View>
            <View
              className={cn(
                "min-w-0 flex-1 gap-1",
                !props.sidebar && "border-b border-border-subtle py-2.5",
              )}
            >
              <View className="flex-row items-center gap-1.5">
                <PullRequestProjectMedia
                  environmentId={item.environmentId}
                  projectId={item.projectId}
                >
                  <PullRequestAvatar actor={item.author} size={16} />
                </PullRequestProjectMedia>
                <Text className={cn("min-w-0 flex-1 text-xs", mutedForeground)} numberOfLines={1}>
                  {item.repository} <Text className={tertiaryForeground}>#{item.number}</Text>
                </Text>
                {item.visibility === "private" ? (
                  <View>
                    <SymbolView
                      name={PullRequestGlyph.private}
                      size={11}
                      tintColorClassName={
                        props.sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
                      }
                    />
                  </View>
                ) : null}
                {item.stack ? (
                  <View className="flex-row items-center gap-1">
                    <SymbolView
                      name={PullRequestGlyph.stack}
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
                  <RelativeTime timestamp={item.updatedAt} />
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
                  {item.labels.slice(0, 2).map((label) => (
                    <ListRowLabel key={label.name} label={label} textClassName={mutedForeground} />
                  ))}
                  {item.labels.length > 2 ? (
                    <Text className={cn("shrink-0 text-2xs", tertiaryForeground)}>
                      +{item.labels.length - 2}
                    </Text>
                  ) : null}
                </View>
                {checks ? (
                  <View className="shrink-0" accessibilityLabel={checksLabel}>
                    <SymbolView name={checks.icon} size={13} tintColorClassName={checks.tint} />
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
        </Menu>
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

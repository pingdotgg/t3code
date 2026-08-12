import type { PullRequestListEntry } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { formatDiffStat, resolvePullRequestState } from "./pullRequestPresentation";
import { PullRequestStateBadge } from "./PullRequestStateBadge";

export function PullRequestRow(props: {
  readonly entry: PullRequestListEntry;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly matchedElsewhere?: boolean;
  readonly showHost?: boolean;
  readonly onPress: (entry: PullRequestListEntry) => void;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const mutedColor = useThemeColor("--color-icon-subtle");
  const presentation = resolvePullRequestState(props.entry);
  const diff = formatDiffStat(props.entry.additions, props.entry.deletions);
  const meta = [
    `#${props.entry.number}`,
    props.entry.repository,
    ...(props.showHost ? [props.entry.host] : []),
    props.entry.author?.login ?? "ghost",
    relativeTime(props.entry.updatedAt),
  ].join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${presentation.label} pull request ${props.entry.title}`}
      onPress={() => props.onPress(props.entry)}
      className="bg-card px-4 py-3 active:opacity-80"
      style={{
        borderTopLeftRadius: props.isFirst ? 20 : 0,
        borderTopRightRadius: props.isFirst ? 20 : 0,
        borderBottomLeftRadius: props.isLast ? 20 : 0,
        borderBottomRightRadius: props.isLast ? 20 : 0,
        borderBottomColor: separatorColor,
        borderBottomWidth: props.isLast ? 0 : 1,
      }}
    >
      <View className="flex-row items-start gap-3">
        <View className="mt-0.5">
          <PullRequestStateBadge
            compact
            isDraft={props.entry.isDraft}
            mergeability={props.entry.mergeability}
            state={props.entry.state}
            baseBranch={props.entry.baseBranch}
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-bold leading-snug text-foreground" numberOfLines={2}>
            {props.entry.title}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {meta}
          </Text>
          <View className="flex-row flex-wrap items-center gap-2">
            {diff ? (
              <Text className="font-mono text-2xs tabular-nums text-foreground-tertiary">
                {diff}
              </Text>
            ) : null}
            {presentation.kind === "conflicting" ? (
              <View className="flex-row items-center gap-1">
                <SymbolView
                  name="exclamationmark.triangle"
                  size={11}
                  tintColor={mutedColor}
                  type="monochrome"
                />
                <Text className={cn("text-2xs font-t3-medium", presentation.textClassName)}>
                  {presentation.label}
                </Text>
              </View>
            ) : null}
            {props.matchedElsewhere ? (
              <Text className="rounded-full border border-border px-1.5 py-0.5 text-2xs text-foreground-muted">
                matched in the description
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { TabActions, TabPill } from "../detail/DetailLayout";
import type { ActivityFilter } from "./pullRequestActivityFilter";

/** A commit: a ring on a line. Neither SF Symbols nor this view's symbol scope has one. */
function CommitGlyph() {
  return (
    <View accessible={false} className="w-4 flex-row items-center">
      <View className="h-[1.5px] flex-1 bg-foreground-muted" />
      <View className="size-2 rounded-full border-[1.5px] border-foreground-muted" />
      <View className="h-[1.5px] flex-1 bg-foreground-muted" />
    </View>
  );
}

/** The Timeline tab's row: comment and commit counts (which filter it), then the order pill. */
export function PullRequestActivityFilters({
  value,
  onChange,
  hiddenCount,
  comments,
  commits,
}: {
  readonly value: ActivityFilter;
  readonly onChange: (value: ActivityFilter) => void;
  readonly hiddenCount: number;
  readonly comments: number;
  readonly commits: number;
}) {
  const gt = useGT();
  const kinds = [
    { id: "all", title: gt("All activity") },
    { id: "comments", title: gt("Comments", { $context: "activity filter" }) },
    { id: "commits", title: gt("Commits", { $context: "activity filter" }) },
  ] as const;
  return (
    <TabActions>
      <Menu
        title={gt("Show in activity")}
        actions={[
          ...kinds.map((kind) => ({
            ...kind,
            state: value.kind === kind.id ? ("on" as const) : ("off" as const),
          })),
          {
            id: "bots",
            title: gt("Bot comments"),
            state: value.bots ? ("on" as const) : ("off" as const),
          },
          {
            id: "resolved",
            title: gt("Resolved or dismissed"),
            state: value.resolved ? ("on" as const) : ("off" as const),
          },
        ]}
        onPressAction={({ nativeEvent: { event } }) => {
          const kind = kinds.find((item) => item.id === event);
          if (kind) onChange({ ...value, kind: kind.id });
          else if (event === "bots" || event === "resolved")
            onChange({ ...value, [event]: !value[event] });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt(
            "{comments, plural, one {{comments} comment} other {{comments} comments}}, {commits, plural, one {{commits} commit} other {{commits} commits}}. Filter activity, {hidden} hidden",
            { comments, commits, hidden: hiddenCount },
          )}
          className="min-h-11 flex-row items-center gap-1.5 active:opacity-60"
        >
          <SymbolView name="text.bubble" size={16} tintColorClassName="accent-foreground-muted" />
          <Text className="text-[15px] tabular-nums text-foreground-muted">{comments} ·</Text>
          <CommitGlyph />
          <Text className="text-[15px] tabular-nums text-foreground-muted">{commits}</Text>
          {hiddenCount > 0 ? (
            <Text className="text-[15px] text-foreground-tertiary">
              {gt("· {count} hidden", { count: hiddenCount })}
            </Text>
          ) : null}
          {value.kind !== "all" ? (
            <View className="ml-1 size-1.5 rounded-full bg-foreground-muted" />
          ) : null}
        </Pressable>
      </Menu>
      <TabPill
        icon={value.newestFirst ? "arrow.down" : "arrow.up"}
        label={value.newestFirst ? gt("Newest first") : gt("Oldest first")}
        onPress={() => onChange({ ...value, newestFirst: !value.newestFirst })}
      />
    </TabActions>
  );
}

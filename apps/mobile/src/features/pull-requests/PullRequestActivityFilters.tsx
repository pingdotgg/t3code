import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ActivityFilter } from "./pullRequestActivityFilter";

export function PullRequestActivityFilters({
  value,
  onChange,
  hiddenCount,
}: {
  readonly value: ActivityFilter;
  readonly onChange: (value: ActivityFilter) => void;
  readonly hiddenCount: number;
}) {
  const gt = useGT();
  const kinds = [
    { id: "all", title: gt("All activity") },
    { id: "comments", title: gt("Comments", { $context: "activity filter" }) },
    { id: "commits", title: gt("Commits", { $context: "activity filter" }) },
  ] as const;
  return (
    <View className="mb-4 flex-row items-center justify-between gap-3">
      <Menu
        title={gt("Activity")}
        actions={kinds.map((kind) => ({ ...kind, state: value.kind === kind.id ? "on" : "off" }))}
        onPressAction={({ nativeEvent }) => {
          const kind = kinds.find((item) => item.id === nativeEvent.event);
          if (kind) onChange({ ...value, kind: kind.id });
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Activity type, {kind}", {
            kind: kinds.find((kind) => kind.id === value.kind)?.title ?? "",
          })}
          className="min-h-11 flex-row items-center gap-2 active:opacity-60"
        >
          <Text className="text-sm font-t3-semibold">
            {kinds.find((kind) => kind.id === value.kind)?.title}
          </Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </Menu>
      <View className="flex-row items-center gap-3">
        <Menu
          title={gt("Show in activity")}
          actions={[
            { id: "bots", title: gt("Bot comments"), state: value.bots ? "on" : "off" },
            {
              id: "resolved",
              title: gt("Resolved or dismissed"),
              state: value.resolved ? "on" : "off",
            },
          ]}
          onPressAction={({ nativeEvent: { event } }) => {
            if (event === "bots" || event === "resolved")
              onChange({ ...value, [event]: !value[event] });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt(
              "{count, plural, one {Filter activity, {count} hidden} other {Filter activity, {count} hidden}}",
              { count: hiddenCount },
            )}
            className="min-h-11 flex-row items-center gap-1.5 active:opacity-60"
          >
            {hiddenCount > 0 ? (
              <Text className="text-xs text-foreground-muted">
                {gt("{count, plural, one {{count} hidden} other {{count} hidden}}", {
                  count: hiddenCount,
                })}
              </Text>
            ) : null}
            <SymbolView
              name="line.3.horizontal.decrease"
              size={18}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        </Menu>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.newestFirst ? gt("Newest first") : gt("Oldest first")}
          onPress={() => onChange({ ...value, newestFirst: !value.newestFirst })}
          className="h-11 flex-row items-center gap-1 active:opacity-60"
        >
          <SymbolView
            name={value.newestFirst ? "arrow.down" : "arrow.up"}
            size={18}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="text-xs text-foreground-muted">
            {value.newestFirst
              ? gt("Newest", { $context: "sort order" })
              : gt("Oldest", { $context: "sort order" })}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

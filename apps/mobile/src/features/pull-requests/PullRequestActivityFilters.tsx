import {
  azureDevOpsDiscussionFilters,
  type AzureDevOpsDiscussionFilter,
} from "@t3tools/client-runtime/azure-devops-discussion-filter";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ActivityFilter } from "./pullRequestActivityFilter";

export function PullRequestActivityFilters({
  value,
  onChange,
  hiddenCount,
  azureCounts,
  countsTruncated,
}: {
  readonly value: ActivityFilter;
  readonly onChange: (value: ActivityFilter) => void;
  readonly hiddenCount: number;
  readonly countsTruncated?: boolean | undefined;
  readonly azureCounts?: Record<AzureDevOpsDiscussionFilter, number> | undefined;
}) {
  const kinds = [
    { id: "all", title: "All activity" },
    { id: "comments", title: "Comments" },
    { id: "commits", title: "Commits" },
  ] as const;
  return (
    <View className="mb-4 flex-row items-center justify-between gap-3">
      {azureCounts ? (
        <Menu
          title="Filter comments"
          actions={azureDevOpsDiscussionFilters.map((item) => ({
            id: item.id,
            title: `${item.label} (${azureCounts[item.id]}${countsTruncated ? "+" : ""})`,
            state: (value.azure ?? "all") === item.id ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const selected = azureDevOpsDiscussionFilters.find(
              (item) => item.id === nativeEvent.event,
            );
            if (selected) onChange({ ...value, azure: selected.id });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Filter comments"
            className="min-h-11 flex-row items-center gap-2 active:opacity-60"
          >
            <Text className="text-sm font-t3-semibold">
              {
                azureDevOpsDiscussionFilters.find((item) => item.id === (value.azure ?? "all"))
                  ?.label
              }{" "}
              ({azureCounts[value.azure ?? "all"]}
              {countsTruncated ? "+" : ""})
            </Text>
            <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      ) : (
        <Menu
          title="Activity"
          actions={kinds.map((kind) => ({ ...kind, state: value.kind === kind.id ? "on" : "off" }))}
          onPressAction={({ nativeEvent }) => {
            const kind = kinds.find((item) => item.id === nativeEvent.event);
            if (kind) onChange({ ...value, kind: kind.id });
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Activity type, ${kinds.find((kind) => kind.id === value.kind)?.title}`}
            className="min-h-11 flex-row items-center gap-2 active:opacity-60"
          >
            <Text className="text-sm font-t3-semibold">
              {kinds.find((kind) => kind.id === value.kind)?.title}
            </Text>
            <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      )}
      <View className="flex-row items-center gap-3">
        {azureCounts ? null : (
          <Menu
            title="Show in activity"
            actions={[
              {
                id: "newOnly",
                title: "What’s new since your last visit",
                state: value.newOnly ? "on" : "off",
              },
              { id: "bots", title: "Bot comments", state: value.bots ? "on" : "off" },
              {
                id: "resolved",
                title: "Resolved or dismissed",
                state: value.resolved ? "on" : "off",
              },
            ]}
            onPressAction={({ nativeEvent: { event } }) => {
              if (event === "bots" || event === "resolved" || event === "newOnly")
                onChange({ ...value, [event]: !value[event] });
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Filter activity, ${hiddenCount} hidden`}
              className="min-h-11 flex-row items-center gap-1.5 active:opacity-60"
            >
              {hiddenCount > 0 ? (
                <Text className="text-xs text-foreground-muted">{hiddenCount} hidden</Text>
              ) : null}
              <SymbolView
                name="line.3.horizontal.decrease"
                size={18}
                tintColorClassName="accent-icon-muted"
              />
            </Pressable>
          </Menu>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={value.newestFirst ? "Newest first" : "Oldest first"}
          onPress={() => onChange({ ...value, newestFirst: !value.newestFirst })}
          className="h-11 flex-row items-center gap-1 active:opacity-60"
        >
          <SymbolView
            name={value.newestFirst ? "arrow.down" : "arrow.up"}
            size={18}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="text-xs text-foreground-muted">
            {value.newestFirst ? "Newest" : "Oldest"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

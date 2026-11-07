import { Button } from "../../../components/ui/Button";
import type { PullRequestReviewGuide } from "@t3tools/contracts";
import { stopFilePaths } from "@t3tools/client-runtime/review-guide-tour";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { PullRequestMarkdown } from "../PullRequestMarkdown";
import { Menu } from "../../../components/ui/Menu";

import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

export function GuideOutline({
  guide,
  onOpen,
  onRewrite,
}: {
  readonly guide: PullRequestReviewGuide;
  readonly onOpen: (position: number) => void;
  readonly onRewrite?: () => void;
}) {
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const files = new Set(guide.stops.flatMap(stopFilePaths));
  return (
    <View>
      <View className="mb-5 flex-row items-center justify-between">
        <View className="flex-row items-baseline gap-2">
          <Text className="text-base font-t3-semibold">{guide.stops.length} stops</Text>
          <Text className="text-sm text-foreground-muted">
            through {files.size} {files.size === 1 ? "file" : "files"}
          </Text>
        </View>
        <Menu
          title="Guide options"
          actions={[
            {
              id: "word-wrap",
              title: "Word wrap",
              image: "text.alignleft",
              state: appearance.codeWordBreak ? "on" : "off",
            },
            ...(onRewrite
              ? [{ id: "rewrite", title: "Rewrite guide", image: "arrow.clockwise" }]
              : []),
          ]}
          onPressAction={({ nativeEvent }) =>
            nativeEvent.event === "word-wrap"
              ? setCodeWordBreak(!appearance.codeWordBreak)
              : onRewrite?.()
          }
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Guide options"
            className="h-11 w-11 items-center justify-center rounded-full active:bg-grouped-card"
          >
            <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      </View>
      {guide.stops[0]?.summary ? (
        <View className="mb-6">
          <PullRequestMarkdown lineBreaks={false} markdown={guide.stops[0].summary} />
        </View>
      ) : null}
      {guide.stops.map((stop, position) => {
        const paths = stopFilePaths(stop);
        const firstPath = paths[0];
        const filename = firstPath?.split("/").at(-1);
        return (
          <Pressable
            key={`${guide.headSha}:${JSON.stringify(stop)}`}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${position + 1}: ${stop.title}`}
            onPress={() => onOpen(position)}
            className="flex-row gap-4 active:opacity-60"
          >
            <View className="w-8 items-center">
              <View className="h-8 w-8 items-center justify-center rounded-full border border-border bg-grouped-card">
                <Text className="text-sm font-t3-medium tabular-nums">{position + 1}</Text>
              </View>
              {position < guide.stops.length - 1 ? (
                <View className="min-h-5 w-px flex-1 bg-border-subtle" />
              ) : null}
            </View>
            <View className="min-w-0 flex-1 gap-2 pb-7 pt-0.5">
              <Text className="text-base leading-6 font-t3-medium">{stop.title}</Text>
              <View className="flex-row items-center gap-1.5">
                {stop.attention ? (
                  <SymbolView name="eye" size={14} tintColorClassName="accent-warning-foreground" />
                ) : null}
                <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                  {filename ?? "Context"}
                  {paths.length > 1 ? ` +${paths.length - 1}` : ""}
                </Text>
              </View>
            </View>
            <View className="pt-2">
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
            </View>
          </Pressable>
        );
      })}
      {guide.stops.length ? (
        <View className="self-end">
          <Button label="Start tour" tone="text" onPress={() => onOpen(0)} icon="arrow.right" />
        </View>
      ) : null}
    </View>
  );
}

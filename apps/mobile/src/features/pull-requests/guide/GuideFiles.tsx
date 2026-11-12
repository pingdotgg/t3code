import { reviewRenameSegments } from "@t3tools/client-runtime/review-workspace";
import { useId, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { PierreEntryIcon } from "../../../components/PierreEntryIcon";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

export type GuideFileMetadata = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly additions: number;
  readonly deletions: number;
};

const ROW_HEIGHT = 44;

/** One horizontal viewport moves every path together; viewed controls stay aligned at the right. */
export function GuideFiles({
  paths,
  files,
  isViewed,
  onToggleViewed,
  onOpenFile,
}: {
  readonly paths: ReadonlyArray<string>;
  readonly files: ReadonlyArray<GuideFileMetadata>;
  readonly isViewed: (path: string) => boolean;
  readonly onToggleViewed?: ((path: string) => void) | undefined;
  readonly onOpenFile: (path: string) => void;
}) {
  const { themeVariables: colors } = useAppearancePreferences();
  const gradientId = `guide-path-fade-${useId().replaceAll(":", "")}`;
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const fadeColor = colors["--color-screen"];
  if (!paths.length) return null;
  const fade = (side: "left" | "right") => (
    <View
      pointerEvents="none"
      accessible={false}
      style={{ position: "absolute", top: 0, bottom: 0, [side]: 0, width: 20 }}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={`${gradientId}-${side}`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0" stopColor={fadeColor} stopOpacity={side === "left" ? 1 : 0} />
            <Stop offset="1" stopColor={fadeColor} stopOpacity={side === "left" ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradientId}-${side})`} />
      </Svg>
    </View>
  );
  return (
    <View className="flex-row overflow-hidden rounded-xl border border-border-subtle bg-screen">
      <View className="min-w-0 flex-1">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          directionalLockEnabled
          scrollEventThrottle={32}
          onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={(width) => setContentWidth(width)}
          onScroll={(event) => {
            const next = event.nativeEvent.contentOffset.x;
            // Only render when an edge cue changes, rather than on every scrolling frame.
            setOffset((current) => {
              const leftChanged = current > 2 !== next > 2;
              const rightChanged =
                current + viewportWidth < contentWidth - 2 !==
                next + viewportWidth < contentWidth - 2;
              return leftChanged || rightChanged ? next : current;
            });
          }}
          contentContainerStyle={{ minWidth: "100%" }}
        >
          <View>
            {paths.map((path) => {
              const file = byPath.get(path);
              const segments = file?.previousPath
                ? reviewRenameSegments(file.previousPath, path, true)
                : null;
              return (
                <Pressable
                  key={path}
                  accessibilityRole="button"
                  accessibilityLabel={`View diff for ${path}${file ? `, ${file.additions} additions, ${file.deletions} deletions` : ""}`}
                  onPress={() => onOpenFile(path)}
                  className="flex-row items-center gap-2 px-3 active:opacity-60"
                  style={{ height: ROW_HEIGHT }}
                >
                  <PierreEntryIcon kind="file" path={path} size={16} />
                  {file ? (
                    <View className="flex-row gap-1">
                      <Text className="text-xs tabular-nums text-adaptive-emerald-600-400">
                        +{file.additions}
                      </Text>
                      <Text className="text-xs tabular-nums text-danger-foreground">
                        −{file.deletions}
                      </Text>
                    </View>
                  ) : null}
                  <Text className="text-xs" numberOfLines={1}>
                    {segments
                      ? segments.map((segment, index) => (
                          <Text
                            key={`${segment.kind}:${segments.slice(0, index).reduce((offset, part) => offset + part.text.length, 0)}:${segment.text}`}
                            className={
                              segment.kind === "removed"
                                ? "bg-red-500/10 text-danger-foreground"
                                : segment.kind === "added"
                                  ? "bg-green-500/10 text-adaptive-emerald-600-400"
                                  : undefined
                            }
                          >
                            {segment.text}
                          </Text>
                        ))
                      : path}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
        {offset > 2 ? fade("left") : null}
        {contentWidth > viewportWidth + 2 && offset + viewportWidth < contentWidth - 2
          ? fade("right")
          : null}
      </View>
      <View className="border-l border-border-subtle bg-screen">
        {paths.map((path) => (
          <Pressable
            key={path}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isViewed(path), disabled: !onToggleViewed }}
            accessibilityLabel={`Viewed ${path}`}
            disabled={!onToggleViewed}
            onPress={() => onToggleViewed?.(path)}
            className="w-11 items-center justify-center"
            style={{ height: ROW_HEIGHT }}
          >
            <SymbolView
              name={isViewed(path) ? "checkmark.square.fill" : "square"}
              size={18}
              tintColorClassName={
                isViewed(path) ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"
              }
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

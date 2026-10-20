import { Button } from "../../../components/ui/Button";
import type { PullRequestReviewGuide } from "@t3tools/contracts";
import { reviewGuideStopProgress } from "@t3tools/client-runtime/review-guide-tour";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Menu } from "../../../components/ui/Menu";
import { GuideFiles, type GuideFileMetadata } from "./GuideFiles";
import { GuideViewOptionsButton } from "./GuideViewOptions";

/** Compact chapter cards preserve separate native chapter navigation. */
export function GuideOutline({
  guide,
  files,
  onOpen,
  onRewrite,
  isViewed,
  onToggleViewed,
  onOpenFile,
  onSetChapterViewed,
}: {
  readonly guide: PullRequestReviewGuide;
  readonly files: ReadonlyArray<GuideFileMetadata>;
  readonly onOpen: (position: number) => void;
  readonly onRewrite?: (() => void) | undefined;
  readonly isViewed: (path: string) => boolean;
  readonly onToggleViewed?: ((path: string) => void) | undefined;
  readonly onOpenFile: (path: string) => void;
  readonly onSetChapterViewed?:
    | ((paths: ReadonlyArray<string>, viewed: boolean) => void)
    | undefined;
}) {
  const reviewedChapters = guide.stops.filter(
    (stop) => reviewGuideStopProgress(stop, isViewed).reviewed,
  ).length;
  return (
    <View>
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs text-foreground-muted">
          {reviewedChapters} of {guide.stops.length} chapters reviewed
          </Text>
        <View className="flex-row items-center">
          <GuideViewOptionsButton />
          {onRewrite ? (
            <Menu
              title="Guide actions"
              actions={[{ id: "rewrite", title: "Rewrite guide", image: "arrow.clockwise" }]}
              onPressAction={() => onRewrite()}
        >
          <Pressable
            accessibilityRole="button"
                accessibilityLabel="Guide actions"
                className="h-11 w-11 items-center justify-center rounded-lg active:bg-grouped-card"
          >
            <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon-muted" />
          </Pressable>
            </Menu>
          ) : null}
        </View>
      </View>
      {guide.stops.map((stop, position) => {
        const progress = reviewGuideStopProgress(stop, isViewed);
        const chapterFiles = files.filter((file) => progress.paths.includes(file.path));
        const totals = chapterFiles.reduce(
          (sum, file) => ({
            additions: sum.additions + file.additions,
            deletions: sum.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        );
        const hasAllStats =
          progress.paths.length > 0 && chapterFiles.length === progress.paths.length;
        return (
          <View
            key={`${guide.headSha}:${JSON.stringify(stop)}`}
            className="mb-3 gap-1 rounded-2xl border border-border-subtle bg-screen p-3"
          >
          <Pressable
            accessibilityRole="button"
              accessibilityLabel={`Chapter ${position + 1}: ${stop.title}`}
            onPress={() => onOpen(position)}
              className="min-h-11 flex-row items-start gap-2 active:opacity-60"
          >
              <View className="mt-1 h-6 w-6 items-center justify-center rounded-full border border-border-subtle">
                {progress.reviewed ? (
                  <SymbolView
                    name="checkmark"
                    size={11}
                    tintColorClassName="accent-adaptive-emerald-600-400"
                  />
                ) : (
                  <Text className="text-xs text-foreground-muted tabular-nums">{position + 1}</Text>
                )}
              </View>
              <View className="min-w-0 flex-1">
                <View className="min-h-7 flex-row items-start justify-between gap-2">
                  <Text className="min-w-0 flex-1 text-sm leading-5 font-t3-semibold">
                    {stop.title}
                  </Text>
                  <View className="h-5 flex-row items-center gap-2">
                    {hasAllStats ? (
                      <View className="flex-row gap-1">
                        <Text className="text-xs tabular-nums text-adaptive-emerald-600-400">
                          +{totals.additions}
                        </Text>
                        <Text className="text-xs tabular-nums text-danger-foreground">
                          −{totals.deletions}
                        </Text>
              </View>
              ) : null}
                    <SymbolView
                      name="chevron.right"
                      size={11}
                      tintColorClassName="accent-icon-muted"
                    />
                  </View>
            </View>
                {stop.attention ? (
                  <Text className="text-xs text-warning-foreground">Look closely</Text>
                ) : null}
                {stop.summary ? (
                  <Text numberOfLines={3} className="mt-1 text-sm leading-5 text-foreground-muted">
                    {stop.summary}
                </Text>
                ) : null}
            </View>
          </Pressable>
            {progress.paths.length ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: progress.reviewed, disabled: !onSetChapterViewed }}
                accessibilityLabel={`Mark chapter ${position + 1} ${progress.reviewed ? "unreviewed" : "reviewed"}`}
                disabled={!onSetChapterViewed}
                className="min-h-11 flex-row items-center gap-2"
                onPress={() => onSetChapterViewed?.(progress.paths, !progress.reviewed)}
              >
                <View className="w-6 items-center">
                <SymbolView
                    name={progress.reviewed ? "checkmark.square.fill" : "square"}
                    size={18}
                    tintColorClassName={
                      progress.reviewed ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"
                    }
                />
                </View>
                <Text className="text-xs text-foreground-muted">
                  {progress.reviewedCount} of {progress.paths.length} files reviewed
                </Text>
              </Pressable>
            ) : (
              <Text className="py-2 text-xs text-foreground-muted">Context, no code</Text>
            )}
            <GuideFiles
              paths={progress.paths}
              files={files}
              isViewed={isViewed}
              onToggleViewed={onToggleViewed}
              onOpenFile={onOpenFile}
                        />
          </View>
        );
      })}
    </View>
  );
}

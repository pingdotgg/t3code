import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

/** Shared chapter navigation for guided and file-type review sequences. */
export function ReviewChapterNavigation({
  chapters,
  position,
  reviewedCount,
  fileCount,
  onSelect,
  onToggleReviewed,
  reviewedDisabled = false,
}: {
  readonly chapters: ReadonlyArray<{ readonly title: string }>;
  readonly position: number;
  readonly reviewedCount: number;
  readonly fileCount: number | null;
  readonly onSelect: (position: number) => void;
  readonly onToggleReviewed?: (() => void) | undefined;
  readonly reviewedDisabled?: boolean;
}) {
  const chapter = chapters[position];
  if (!chapter) return null;
  const reviewed = fileCount !== null && fileCount > 0 && reviewedCount === fileCount;
  return (
    <View>
      <View className="flex-row items-center gap-2">
        <View className="h-6 w-6 items-center justify-center rounded-full border border-border bg-grouped-card">
          <Text className="text-xs font-t3-medium tabular-nums">{position + 1}</Text>
        </View>
        <View className="min-w-0 flex-1">
          <Menu
            title="Chapters"
            actions={chapters.map((item, index) => ({
              id: String(index),
              title: `${index + 1}. ${item.title}`,
              state: index === position ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => onSelect(Number(nativeEvent.event))}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Chapter ${position + 1} of ${chapters.length}: ${chapter.title}`}
              className="min-h-11 min-w-0 flex-row items-center gap-2"
            >
              <Text numberOfLines={1} className="min-w-0 shrink text-sm font-t3-semibold">
                {chapter.title}
              </Text>
              <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </Menu>
        </View>
        {onToggleReviewed ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: reviewed, disabled: reviewedDisabled }}
            accessibilityLabel={`Mark chapter ${position + 1} ${reviewed ? "unreviewed" : "reviewed"}`}
            disabled={reviewedDisabled}
            className="min-h-11 min-w-11 items-center justify-center disabled:opacity-40"
            onPress={onToggleReviewed}
          >
            <SymbolView
              name={reviewed ? "checkmark.circle.fill" : "circle"}
              size={19}
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        ) : null}
        {([-1, 1] as const).map((delta) => {
          const disabled = position + delta < 0 || position + delta >= chapters.length;
          return (
            <Pressable
              key={delta}
              accessibilityRole="button"
              accessibilityLabel={delta < 0 ? "Previous chapter" : "Next chapter"}
              accessibilityState={{ disabled }}
              disabled={disabled}
              className="min-h-11 min-w-11 items-center justify-center disabled:opacity-40"
              onPress={() => onSelect(position + delta)}
            >
              <SymbolView
                name={delta < 0 ? "chevron.left" : "chevron.right"}
                size={15}
                tintColorClassName="accent-icon-muted"
              />
            </Pressable>
          );
        })}
      </View>
      <Text className="pb-2 text-xs text-foreground-muted">
        Chapter {position + 1} of {chapters.length} ·{" "}
        {fileCount === null
          ? "Loading review counts…"
          : `${reviewedCount} of ${fileCount} files reviewed`}
      </Text>
    </View>
  );
}

import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Menu } from "../../../components/ui/Menu";

/** Keep the chapter switcher compact and put the whole-file review action beside its count. */
export function GuideChapterNavigation({
  chapters,
  position,
  reviewedCount,
  fileCount,
  onSelect,
  onToggleReviewed,
}: {
  readonly chapters: ReadonlyArray<{ readonly title: string }>;
  readonly position: number;
  readonly reviewedCount: number;
  readonly fileCount: number;
  readonly onSelect: (position: number) => void;
  readonly onToggleReviewed?: (() => void) | undefined;
}) {
  const chapter = chapters[position];
  if (!chapter) return null;
  const reviewed = fileCount > 0 && reviewedCount === fileCount;
  return (
    <View>
      <View className="flex-row items-center gap-2">
        <Text className="text-xs text-foreground-muted tabular-nums">
          {position + 1}/{chapters.length}
        </Text>
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
              <Text numberOfLines={2} className="min-w-0 flex-1 text-sm leading-5 font-t3-semibold">
                {chapter.title}
              </Text>
              <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </Menu>
        </View>
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
      {fileCount > 0 ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: reviewed, disabled: !onToggleReviewed }}
          accessibilityLabel={`Mark chapter ${position + 1} ${reviewed ? "unreviewed" : "reviewed"}`}
          disabled={!onToggleReviewed}
          onPress={onToggleReviewed}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView
            name={reviewed ? "checkmark.square.fill" : "square"}
            size={18}
            tintColorClassName={reviewed ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"}
          />
          <Text className="text-xs text-foreground-muted">
            {reviewedCount} of {fileCount} files reviewed
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

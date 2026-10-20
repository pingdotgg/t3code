import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { buildReviewSectionMenu } from "./review-section-menu";
import type { ReviewSectionItem } from "./reviewModel";

export function ReviewComparisonPicker({
  sections,
  selected,
  onSelect,
}: {
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selected: ReviewSectionItem | null;
  readonly onSelect: (sectionId: string) => void;
}) {
  const menu = buildReviewSectionMenu(sections);
  const action = (section: ReviewSectionItem | null, title: string) => ({
    id: section?.id ?? `unavailable:${title}`,
    title,
    attributes: { disabled: section === null },
    state: section !== null && section.id === selected?.id ? ("on" as const) : ("off" as const),
  });
  const title =
    selected?.kind === "working-tree"
      ? "Uncommitted changes"
      : selected?.kind === "branch-range"
        ? "Branch changes"
        : (selected?.title ?? "Select comparison");
  return (
    <View className="min-h-11 flex-row items-center gap-2 border-b border-border-subtle bg-sheet px-3">
      <View className="min-w-0 flex-1">
        <Menu
          title="Compare changes"
          actions={[
            action(menu.workingTree, "Uncommitted changes"),
            action(menu.branchChanges, "Branch changes"),
            action(menu.latestTurn, "Latest turn"),
            ...(menu.turns.length
              ? [
                  {
                    id: "turns",
                    title: "Earlier turns",
                    subactions: menu.turns.map((section) => action(section, section.title)),
                  },
                ]
              : []),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (sections.some((section) => section.id === nativeEvent.event))
              onSelect(nativeEvent.event);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Compare changes: ${title}`}
            className="min-h-11 flex-row items-center gap-2"
          >
            <Text numberOfLines={1} className="min-w-0 shrink text-sm font-t3-medium">
              {title}
            </Text>
            <SymbolView name="chevron.down" size={13} tintColorClassName="accent-icon-muted" />
          </Pressable>
        </Menu>
      </View>
    </View>
  );
}

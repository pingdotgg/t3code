import type { StackHeaderConfigProps, StackHeaderMenuElementIOS } from "react-native-screens";

export type HeaderItem = NonNullable<
  NonNullable<StackHeaderConfigProps["ios"]>["leadingItems"]
>[number];

function isSearchPlacement(item: HeaderItem) {
  return "searchBarPlacement" in item && item.searchBarPlacement === true;
}

function drawnInVerticalBar(item: HeaderItem) {
  return item.type === "item" && item.axisBehavior !== "horizontalOnly" && !isSearchPlacement(item);
}

function verticalBarGroupSizes(items: readonly HeaderItem[]) {
  const sizes = [0];
  for (const item of items) {
    if (item.type === "spacer") sizes.push(0);
    else if (drawnInVerticalBar(item)) sizes[sizes.length - 1]! += 1;
  }
  return sizes;
}

function foldIntoMoreMenu(items: readonly HeaderItem[]): HeaderItem {
  const children = items.flatMap<StackHeaderMenuElementIOS>((item) => {
    if (item.type !== "item" || "render" in item) return [];
    if (item.menu) return [{ ...item.menu, title: item.title ?? item.menu.title, icon: item.icon }];
    return [
      {
        id: `${item.id}:more`,
        type: "menuItem" as const,
        itemType: "action" as const,
        title: item.title,
        icon: item.icon,
        onPress: item.onPress,
        disabled: !item.onPress,
      },
    ];
  });
  return {
    type: "item",
    id: "vertical-bar-more",
    title: "More",
    icon: { type: "sfSymbol", name: "ellipsis" },
    menu: { id: "vertical-bar-more:menu", type: "menu", children },
  };
}

export function fitVerticalBarItems(
  items: readonly HeaderItem[],
  fits: (groupSizes: readonly number[]) => boolean,
): readonly HeaderItem[] {
  const foldable = (item: HeaderItem) => drawnInVerticalBar(item) && !("render" in item);
  const folded = items.filter(foldable);
  if (folded.length < 2 || fits(verticalBarGroupSizes(items))) return items;
  return [
    foldIntoMoreMenu(folded),
    ...items.filter((item) => item.type === "item" && !foldable(item)),
  ];
}

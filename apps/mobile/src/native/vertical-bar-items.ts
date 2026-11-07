import type { StackHeaderConfigProps, StackHeaderMenuElementIOS } from "react-native-screens";
import { verticalBarGroupsFitAboveTabBar, type NativeLayoutMetrics } from "../lib/reserved-regions";

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

/**
 * Fits a column's trailing items between Back and its leading items above, and compose and the
 * keyboard dismiss below. A collapsed split draws Back on every detail screen; an expanded
 * split's detail column is its own stack, so only its first screen has none.
 */
export function fitColumnVerticalBarItems(
  metrics: NativeLayoutMetrics,
  tabCount: number,
  bar: {
    readonly backButtonVisible: boolean;
    readonly detailRoot: boolean;
    readonly leading: readonly HeaderItem[];
    readonly trailing: readonly HeaderItem[];
    readonly compose: boolean;
    readonly keyboardVisible: boolean;
  },
) {
  const back =
    bar.backButtonVisible && (metrics.horizontalSizeClass === "compact" || !bar.detailRoot);
  const leadingGroupSizes = [back ? 1 : 0, ...verticalBarGroupSizes(bar.leading)];
  return fitVerticalBarItems(bar.trailing, (groupSizes) =>
    verticalBarGroupsFitAboveTabBar(metrics, tabCount, [
      ...leadingGroupSizes,
      ...groupSizes,
      bar.compose ? 1 : 0,
      bar.keyboardVisible ? 1 : 0,
    ]),
  );
}

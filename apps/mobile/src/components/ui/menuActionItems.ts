import type { MenuAction } from "@react-native-menu/menu";
import type { AppBarMenuItem } from "./AppBar.types";

/** Adapts a `MenuAction` tree and its selection handler to `AppBar` menu items. */
export function appBarMenuItemsFromActions(
  actions: ReadonlyArray<MenuAction>,
  onSelect: (id: string) => void,
): AppBarMenuItem[] {
  return actions.map((action, index) => {
    const id = action.id ?? String(index);
    return action.subactions?.length
      ? {
          id,
          title: action.title,
          icon: action.image,
          items: appBarMenuItemsFromActions(action.subactions, onSelect),
        }
      : {
          id,
          title: action.title,
          subtitle: action.subtitle,
          icon: action.image,
          selected: action.state === "on",
          disabled: action.attributes?.disabled,
          onPress: () => onSelect(id),
        };
  });
}

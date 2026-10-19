import type { MenuAction } from "@react-native-menu/menu";
import type { AppBarMenuItem } from "./AppBar.types";

export function androidHeaderMenuActions(items: ReadonlyArray<AppBarMenuItem>): MenuAction[] {
  return items.flatMap((item): MenuAction[] =>
    "items" in item
      ? item.inline && !item.title
        ? androidHeaderMenuActions(item.items)
        : [
            {
              id: item.id,
              title: item.title ?? "",
              image: item.icon,
              subactions: androidHeaderMenuActions(item.items),
            },
          ]
      : [
          {
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            image: item.icon,
            state: item.selected ? "on" : undefined,
            attributes: item.disabled ? { disabled: true } : undefined,
          },
        ],
  );
}

export function findHeaderMenuAction(
  items: ReadonlyArray<AppBarMenuItem>,
  id: string,
): Extract<AppBarMenuItem, { readonly onPress: () => void }> | undefined {
  for (const item of items) {
    if ("items" in item) {
      const action = findHeaderMenuAction(item.items, id);
      if (action) return action;
    } else if (item.id === id) {
      return item;
    }
  }
  return undefined;
}

export function splitAndroidHeaderActions<Action extends { readonly overflowOnly?: boolean }>(
  actions: ReadonlyArray<Action>,
  wide: boolean,
) {
  const inline = actions.filter((action) => !action.overflowOnly);
  const directCount = actions.length > 2 ? (wide ? 3 : 1) : inline.length;
  const visibleActions = inline.slice(0, directCount);
  return {
    visibleActions,
    overflowActions: actions.filter((action) => !visibleActions.includes(action)),
  };
}

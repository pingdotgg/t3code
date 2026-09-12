import type { MenuAction } from "@react-native-menu/menu";

// MenuView's iOS bridge treats an omitted imageColor as transparent.
export function withMenuActionIconColors(
  actions: readonly MenuAction[],
  colors: {
    readonly icon: MenuAction["imageColor"];
    readonly destructiveIcon: MenuAction["imageColor"];
  },
): MenuAction[] {
  return actions.map((action) => ({
    ...action,
    ...(action.image
      ? {
          imageColor:
            action.imageColor ??
            (action.attributes?.destructive ? colors.destructiveIcon : colors.icon),
        }
      : {}),
    ...(action.subactions
      ? { subactions: withMenuActionIconColors(action.subactions, colors) }
      : {}),
  }));
}

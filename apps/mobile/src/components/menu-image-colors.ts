import type { MenuAction } from "@react-native-menu/menu";
export function applyDefaultMenuImageColors(
  actions: readonly MenuAction[],
  colors: { readonly default: string | number; readonly destructive: string | number },
): MenuAction[] {
  return actions.map((action) => ({
    ...action,
    ...(action.image !== undefined && action.imageColor === undefined
      ? {
          imageColor: action.attributes?.destructive === true ? colors.destructive : colors.default,
        }
      : {}),
    ...(action.subactions
      ? { subactions: applyDefaultMenuImageColors(action.subactions, colors) }
      : {}),
  }));
}

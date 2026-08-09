import type { MenuAction } from "@react-native-menu/menu";

export interface AndroidMenuEntry {
  readonly action: MenuAction;
  readonly dividerBefore: boolean;
}

export function flattenInlineMenuSections(actions: readonly MenuAction[]): AndroidMenuEntry[] {
  const entries: AndroidMenuEntry[] = [];
  for (const action of actions) {
    if (action.attributes?.hidden === true) continue;
    if (action.displayInline === true && action.subactions) {
      const visibleChildren = action.subactions.filter(
        (child) => child.attributes?.hidden !== true,
      );
      for (const [index, child] of visibleChildren.entries()) {
        entries.push({ action: child, dividerBefore: index === 0 && entries.length > 0 });
      }
      continue;
    }
    entries.push({ action, dividerBefore: false });
  }
  return entries;
}

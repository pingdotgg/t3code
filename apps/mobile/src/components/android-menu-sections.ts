import type { MenuAction } from "@react-native-menu/menu";

interface AndroidMenuEntry {
  readonly action: MenuAction;
  readonly dividerBefore: boolean;
}

export function flattenInlineMenuSections(actions: readonly MenuAction[]) {
  const entries: AndroidMenuEntry[] = [];
  let previousWasInlineGroup = false;
  for (const action of actions) {
    if (action.attributes?.hidden === true) continue;
    if (action.displayInline === true && action.subactions) {
      const visibleChildren = action.subactions.filter(
        (child) => child.attributes?.hidden !== true,
      );
      for (const [index, child] of visibleChildren.entries()) {
        entries.push({ action: child, dividerBefore: index === 0 && entries.length > 0 });
      }
      if (visibleChildren.length > 0) previousWasInlineGroup = true;
      continue;
    }
    entries.push({ action, dividerBefore: previousWasInlineGroup && entries.length > 0 });
    previousWasInlineGroup = false;
  }
  return entries;
}

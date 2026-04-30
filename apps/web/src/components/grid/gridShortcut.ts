/**
 * Local keyboard shortcut for toggling grid split view.
 *
 * We don't route this through the centralized `KeybindingsConfig` because that
 * requires contract + server changes. Grid view is a client-only concern, so a
 * local matcher keeps the plumbing tight. Default shortcut: Ctrl/Cmd+Shift+G.
 */
import { isMacPlatform } from "../../lib/utils";
import type { ShortcutEventLike } from "../../keybindings";

export function isGridSplitViewShortcut(
  event: ShortcutEventLike,
  platform: string = typeof navigator !== "undefined" ? navigator.platform : "",
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  const key = (event.key ?? "").toLowerCase();
  if (key !== "g") return false;
  if (!event.shiftKey) return false;
  if (event.altKey) return false;
  const useMeta = isMacPlatform(platform);
  if (useMeta) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}

export const GRID_SPLIT_VIEW_SHORTCUT_LABEL = "Ctrl+Shift+G";
export const GRID_SPLIT_VIEW_SHORTCUT_LABEL_MAC = "\u2318\u21e7G";

export function gridSplitViewShortcutLabel(
  platform: string = typeof navigator !== "undefined" ? navigator.platform : "",
): string {
  return isMacPlatform(platform)
    ? GRID_SPLIT_VIEW_SHORTCUT_LABEL_MAC
    : GRID_SPLIT_VIEW_SHORTCUT_LABEL;
}

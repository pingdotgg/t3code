import type {
  DesktopPreviewForwardedShortcut,
  DesktopPreviewShortcutEvent,
} from "@t3tools/contracts";
import { shortcutKeysFromEvent } from "@t3tools/shared/keybindings";

type ShortcutInput = Pick<
  Electron.Input,
  "type" | "key" | "code" | "meta" | "control" | "shift" | "alt" | "isAutoRepeat"
>;

/**
 * The event to hand back to the app when a press in a focused preview page is
 * one of the app's forwarded shortcuts, or null when the page keeps the key.
 * Presses without Command or Control are typing, so they always stay with the
 * page.
 */
export const forwardedShortcutEvent = (
  input: ShortcutInput,
  shortcuts: ReadonlyArray<DesktopPreviewForwardedShortcut>,
  platform: NodeJS.Platform,
): DesktopPreviewShortcutEvent | null => {
  if (input.type !== "keyDown" || (!input.meta && !input.control)) return null;
  // Windows reports AltGr as Control+Alt. A symbol typed with it is text, not
  // a chord, matching the renderer's AltGraph rule.
  if (platform !== "darwin" && input.control && input.alt && !/^[a-z0-9]$/i.test(input.key)) {
    return null;
  }
  const keys = shortcutKeysFromEvent(input);
  const claimed = shortcuts.some(
    (shortcut) =>
      shortcut.metaKey === input.meta &&
      shortcut.ctrlKey === input.control &&
      shortcut.shiftKey === input.shift &&
      shortcut.altKey === input.alt &&
      keys.has(shortcut.key),
  );
  if (!claimed) return null;
  return {
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    shiftKey: input.shift,
    altKey: input.alt,
    repeat: input.isAutoRepeat,
  };
};

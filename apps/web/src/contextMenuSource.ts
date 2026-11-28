import type { ContextMenuSource } from "@t3tools/contracts";

// Menus opened by openContextMenuFromKeyboard; a script-made event cannot keep button -1.
const keyboardContextMenus = new WeakSet<Event>();

// Chromium uses no button for keyboard context menus and zero clicks for keyboard activation.
export function contextMenuSourceOf(
  event: Pick<MouseEvent, "type" | "button" | "detail"> & { readonly nativeEvent?: Event },
): ContextMenuSource {
  if (event.nativeEvent !== undefined && keyboardContextMenus.has(event.nativeEvent)) {
    return "keyboard";
  }
  return (event.type === "click" ? event.detail === 0 : event.button === -1) ? "keyboard" : "mouse";
}

/**
 * Opens an element's context menu from the keyboard. Chromium on macOS turns neither
 * Shift+F10 nor the ContextMenu key into a `contextmenu` event, so the key is handled
 * here and the element's own handler receives a menu event that reads as keyboard-opened.
 * Preventing the key keeps other platforms from opening the menu a second time.
 */
export function openContextMenuFromKeyboard(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault"> & {
    readonly currentTarget: Element;
  },
): void {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  const menu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: bounds.left,
    clientY: bounds.bottom,
  });
  keyboardContextMenus.add(menu);
  event.currentTarget.dispatchEvent(menu);
}

import type { ShortcutKeyboardLayoutMap } from "@t3tools/shared/keybindings";

interface KeyboardLayoutSource extends Partial<
  Pick<EventTarget, "addEventListener" | "removeEventListener">
> {
  getLayoutMap(): Promise<ShortcutKeyboardLayoutMap>;
}

let keyboardLayoutMap: ShortcutKeyboardLayoutMap | undefined;

export function getKeyboardLayoutMap() {
  return keyboardLayoutMap;
}

// Option changes event.key to a symbol on macOS; the layout map recovers the
// letter printed on that key without assuming a US physical layout.
export function trackKeyboardLayout(
  keyboard = (navigator as Navigator & { keyboard?: KeyboardLayoutSource }).keyboard,
  focusTarget: EventTarget | undefined = typeof window === "undefined" ? undefined : window,
) {
  let revision = 0;
  const refresh = async () => {
    const request = ++revision;
    keyboardLayoutMap = undefined;
    try {
      const layout = await keyboard?.getLayoutMap();
      if (request === revision) keyboardLayoutMap = layout;
    } catch {
      // Unsupported or permission-blocked browsers keep the existing fallback.
    }
  };
  void refresh();
  keyboard?.addEventListener?.("layoutchange", refresh);
  focusTarget?.addEventListener("focus", refresh);
  return () => {
    revision++;
    keyboardLayoutMap = undefined;
    keyboard?.removeEventListener?.("layoutchange", refresh);
    focusTarget?.removeEventListener("focus", refresh);
  };
}

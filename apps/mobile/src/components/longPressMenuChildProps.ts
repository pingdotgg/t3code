/** Shorter than UIKit's ~500ms context-menu threshold (and than React Native's
    own 500ms default) so the long press is registered before the menu is
    committed. */
export const IOS_MENU_LONG_PRESS_DELAY_MS = 400;

/**
 * Props a long-press menu injects into the child it wraps on iOS, replacing
 * whatever the child had (the menu owns the long press, as it does on Android).
 * React Native only drops a Pressable's onPress after a long press when that
 * Pressable has an onLongPress at all, so it gets a no-op: enough to keep the
 * tap from firing when the finger lifts off an open context menu. No haptic
 * here, UIKit plays the context-menu one itself. One frozen object, so cloning
 * a child never changes prop identity between renders.
 */
export const longPressMenuChildProps = Object.freeze({
  onLongPress: () => undefined,
  delayLongPress: IOS_MENU_LONG_PRESS_DELAY_MS,
});

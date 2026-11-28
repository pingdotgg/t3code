import { isAltGraphText } from "@t3tools/shared/keybindingMatching";

type SurfaceKeyEvent = Pick<KeyboardEvent, "key"> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutKey(event: SurfaceKeyEvent): string | null {
  // AltGr text must stay text even when the browser omits Ctrl and Alt.
  if (isAltGraphText(event)) return null;
  const typed = event.key.toLowerCase();
  // Preserve Latin layouts, punctuation and dead keys; non-Latin letters/marks use the physical key.
  const physical =
    /^[\p{L}\p{M}]+$/u.test(typed) && !/\p{Script=Latin}/u.test(typed)
      ? event.code?.match(/^Key([A-Z])$/)?.[1]?.toLowerCase()
      : undefined;
  return physical ?? typed;
}

/**
 * Splits a formatted shortcut label into individual keycaps for display
 * (ported from the fork's sidebar). macOS symbol labels ("⌘K", "⌃⇧P") are
 * split per modifier glyph; other platforms split on "+" ("Ctrl+K").
 */
export function splitShortcutLabelIntoKeycaps(label: string): string[] {
  if (label.includes("⌘") || label.includes("⌃") || label.includes("⌥")) {
    const keycaps: string[] = [];
    if (label.includes("⌃")) keycaps.push("⌃");
    if (label.includes("⌥")) keycaps.push("⌥");
    if (label.includes("⇧")) keycaps.push("⇧");
    if (label.includes("⌘")) keycaps.push("⌘");

    const key = label.replace(/[⌃⌥⇧⌘]/g, "").trim();
    if (key.length > 0) {
      keycaps.push(key.toUpperCase());
    }

    return keycaps;
  }

  return label
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

import type { ReviewRating } from "@t3tools/contracts";

export const RATINGS = [
  "again",
  "hard",
  "good",
  "easy",
] as const satisfies ReadonlyArray<ReviewRating>;

/** Controls that Space and Enter already operate. */
const OPERATED = "button, a[href], summary, [role=button], [role=menuitem], [role=option]";

/** What a key pressed during a review does, when the control it was pressed in does not use it. */
export function studyKey(event: KeyboardEvent): "close" | "flip" | ReviewRating | undefined {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]")) return undefined;
  if (event.key === "Escape") return "close";
  if (event.key === " " || event.key === "Enter") {
    return target?.closest(OPERATED) ? undefined : "flip";
  }
  return /^[1-4]$/.test(event.key) ? RATINGS[Number(event.key) - 1] : undefined;
}

// Screen readers skip a live region that appears already filled, and moving focus cuts off
// whatever they were saying. So the regions exist before the first message lands, and
// messages wait until focus has stayed put for a moment, then are spoken together.
const FOCUS_SETTLE_MS = 250;

let regions: readonly [HTMLElement, HTMLElement] | null = null;
let pending: { message: string; source: string | undefined }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FOCUS_SETTLE_MS);
}

function flush() {
  if (!regions || pending.length === 0) return;
  const [first, second] = regions;
  // Alternating between two regions lets the same message be spoken twice in a row.
  const target = first.textContent ? second : first;
  first.textContent = "";
  second.textContent = "";
  target.textContent = pending.map((entry) => entry.message).join(". ");
  pending = [];
}

function createRegion() {
  const region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  document.body.append(region);
  return region;
}

/**
 * Tells screen reader users what an action did when focus alone doesn't show it. A message
 * replaces one still waiting from the same `source`, so a superseded status isn't read out.
 */
export function announce(message: string, source?: string) {
  // Stores announce without a mounted owner, so they also run where no DOM exists (unit tests).
  if (typeof document === "undefined") return;
  if (!regions) {
    regions = [createRegion(), createRegion()];
    document.addEventListener("focusin", () => {
      if (pending.length > 0) scheduleFlush();
    });
  }
  if (source !== undefined) pending = pending.filter((entry) => entry.source !== source);
  if (pending.at(-1)?.message !== message) pending.push({ message, source });
  scheduleFlush();
}

/** Drops a message from `source` that hasn't been spoken yet, once it no longer applies. */
export function cancelAnnouncement(source: string) {
  pending = pending.filter((entry) => entry.source !== source);
}

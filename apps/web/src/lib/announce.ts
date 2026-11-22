// Screen readers skip a live region that appears already filled, and moving focus cuts off
// whatever they were saying. So the regions exist before the first message lands, and
// messages wait until focus has stayed put for a moment, then are spoken together.
const FOCUS_SETTLE_MS = 250;

// NVDA reads a polite region's leftover text again when focus returns from a
// dialog, so an announcement is cleared once it has had time to be spoken.
// Clearing doesn't cut off speech that already started.
export const CLEAR_SPOKEN_AFTER_MS = 7_000;

let regions: readonly [HTMLElement, HTMLElement] | null = null;
let pending: { message: string; source: string | undefined }[] = [];
let spokenSources: (string | undefined)[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FOCUS_SETTLE_MS);
}

function clearSpoken() {
  clearTimeout(clearTimer);
  spokenSources = [];
  for (const region of regions ?? []) region.textContent = "";
}

function flush() {
  if (!regions || pending.length === 0) return;
  clearSpoken();
  // Alternating between two regions lets the same message be spoken twice in a row.
  const [target, other] = regions;
  regions = [other, target];
  target.textContent = pending.map((entry) => entry.message).join(". ");
  spokenSources = pending.map((entry) => entry.source);
  pending = [];
  clearTimer = setTimeout(clearSpoken, CLEAR_SPOKEN_AFTER_MS);
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

/** Drops a message from `source`, waiting or already spoken, once it no longer applies. */
export function cancelAnnouncement(source: string) {
  pending = pending.filter((entry) => entry.source !== source);
  if (spokenSources.includes(source)) clearSpoken();
}

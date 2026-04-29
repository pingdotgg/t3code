import { type MessageId } from "@t3tools/contracts";

import { deriveDisplayedUserMessageState } from "../../lib/terminalContext.ts";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface MinimapUserMessageEntry {
  rowIndex: number;
  rowKey: string;
  messageId: MessageId;
  previewText: string;
}

export interface MinimapListStateSnapshot {
  scroll: number;
  scrollLength: number;
  /** True when the list is scrolled to (or within LegendList's at-end
   *  threshold of) the bottom. Used by `computeActiveMinimapIndex` to pin
   *  the last user message as active when the layout never lets its top
   *  reach the viewport top — a short final prompt with nothing below it
   *  is the canonical case. */
  isAtEnd?: boolean;
  positionByKey?: (key: string) => number | undefined;
  positionAtIndex?: (index: number) => number | undefined;
}

export function selectUserMessageMinimapEntries(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MinimapUserMessageEntry[] {
  const entries: MinimapUserMessageEntry[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || row.kind !== "message" || row.message.role !== "user") {
      continue;
    }
    const displayed = deriveDisplayedUserMessageState(row.message.text ?? "");
    const visible = displayed.visibleText.trim();
    const previewText =
      visible.length > 0 ? visible : displayed.contextCount > 0 ? "(terminal context)" : "";
    entries.push({
      rowIndex,
      rowKey: row.id,
      messageId: row.message.id,
      previewText,
    });
  }
  return entries;
}

// Visual constants matched to the DashesStrip CSS in `ChatMinimap.tsx`.
// Keep these in sync with `h-0.75` (dash height), `gap-1` (vertical gap), and
// `py-1` (vertical padding) on the strip's <ul>.
const MINIMAP_DASH_HEIGHT_PX = 3;
const MINIMAP_DASH_GAP_PX = 4;
const MINIMAP_STRIP_VERTICAL_PADDING_PX = 8;
const MINIMAP_PIXELS_PER_ROW = MINIMAP_DASH_HEIGHT_PX + MINIMAP_DASH_GAP_PX;

/** Hard ceiling on the dash count regardless of viewport size — long threads
 *  get sampled down to this many dashes. Reduces visual noise while the
 *  expanded preview menu remains the source of truth for exact navigation.
 *  Mirrors the `MAX_VISIBLE_WORK_LOG_ENTRIES = 6` precedent in
 *  `MessagesTimeline.logic.ts`. */
const MAX_VISIBLE_MINIMAP_DASHES = 10;

interface SelectVisibleMinimapEntriesArgs {
  entries: ReadonlyArray<MinimapUserMessageEntry>;
  /** Total available height for the strip in pixels, or `null` before the strip has been measured. */
  navHeight: number | null;
  activeIndex: number | null;
}

interface SelectVisibleMinimapEntriesResult {
  visibleEntries: ReadonlyArray<MinimapUserMessageEntry>;
  visibleActiveIndex: number | null;
  /** Entries not represented by their own dash. `0` when every entry fits
   *  (one-dash-per-message). Positive when sampling is in effect — the
   *  caller surfaces this as a small "+N more" label below the strip so
   *  the reader knows the strip is a compressed view. */
  hiddenCount: number;
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(length - 1, index));

/**
 * Choose which entries to draw and which one to highlight.
 *
 * If every entry fits at natural density (one dash per user message) we pass
 * them through unchanged. Once there isn't room for one row per message we
 * sample evenly down to the column's capacity — keeping the first and last
 * entries pinned and mapping the active index to the nearest sampled slot.
 *
 * The strip never scrolls and dashes never overlap; if a thread is so long
 * that there isn't room for one dash per message, multiple messages share a
 * single dash. The expanded preview card remains the source of truth for
 * exact navigation.
 */
export function selectVisibleMinimapEntries({
  entries,
  navHeight,
  activeIndex,
}: SelectVisibleMinimapEntriesArgs): SelectVisibleMinimapEntriesResult {
  if (entries.length === 0) {
    return { visibleEntries: entries, visibleActiveIndex: null, hiddenCount: 0 };
  }

  const sourceActiveIndex = activeIndex === null ? null : clampIndex(activeIndex, entries.length);

  // The 10-dash cap applies whether or not the strip has been measured.
  // When unmeasured, capping at MAX_VISIBLE_MINIMAP_DASHES doubles as the
  // overflow guard for long initial-render threads (no flash, no jank). When
  // measured, take the smaller of the column's pixel capacity and the cap so
  // a tall viewport never grows past `MAX_VISIBLE_MINIMAP_DASHES`, and a very
  // short column still falls back to whatever it can physically fit.
  const capacity =
    navHeight === null
      ? MAX_VISIBLE_MINIMAP_DASHES
      : Math.min(
          MAX_VISIBLE_MINIMAP_DASHES,
          Math.max(
            1,
            Math.floor(
              Math.max(0, navHeight - MINIMAP_STRIP_VERTICAL_PADDING_PX) / MINIMAP_PIXELS_PER_ROW,
            ),
          ),
        );

  if (entries.length <= capacity) {
    return { visibleEntries: entries, visibleActiveIndex: sourceActiveIndex, hiddenCount: 0 };
  }

  // Degenerate single-slot case — just surface whichever entry is currently
  // active so the highlight has something meaningful to land on.
  if (capacity === 1) {
    const sourceIndex = sourceActiveIndex ?? 0;
    return {
      visibleEntries: [entries[sourceIndex]!],
      visibleActiveIndex: 0,
      hiddenCount: entries.length - 1,
    };
  }

  const step = (entries.length - 1) / (capacity - 1);
  const visibleEntries: MinimapUserMessageEntry[] = [];
  for (let i = 0; i < capacity; i += 1) {
    visibleEntries.push(entries[Math.round(i * step)]!);
  }

  let visibleActiveIndex: number | null = null;
  if (sourceActiveIndex !== null) {
    const projected = Math.round((sourceActiveIndex * (capacity - 1)) / (entries.length - 1));
    visibleActiveIndex = Math.max(0, Math.min(capacity - 1, projected));
  }

  return {
    visibleEntries,
    visibleActiveIndex,
    hiddenCount: entries.length - visibleEntries.length,
  };
}

export function computeActiveMinimapIndex(
  state: MinimapListStateSnapshot,
  entries: ReadonlyArray<MinimapUserMessageEntry>,
): number | undefined {
  if (entries.length === 0) return undefined;
  if (state.scrollLength <= 0) return undefined;

  // When the list is scrolled to the very end, the last user message is what
  // the reader is looking at — even if the layout never lets its top reach
  // the viewport top (a short final prompt with no content below it is the
  // canonical case). Without this short-circuit, the viewport-top rule keeps
  // an earlier prompt lit while the reader is plainly looking at the latest.
  if (state.isAtEnd === true) {
    return entries.length - 1;
  }

  const threshold = state.scroll + 8;
  let next: number | undefined;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const position = state.positionByKey?.(entry.rowKey) ?? state.positionAtIndex?.(entry.rowIndex);
    if (position === undefined) {
      if (next === undefined) continue;
      break;
    }
    if (position <= threshold) {
      next = i;
    } else {
      if (next === undefined && i === 0) return 0;
      break;
    }
  }

  if (next === undefined) return undefined;

  while (next + 1 < entries.length) {
    const currentEntry = entries[next]!;
    const nextEntry = entries[next + 1]!;
    const currentMessageBottom = state.positionAtIndex?.(currentEntry.rowIndex + 1);
    const nextEntryTop =
      state.positionByKey?.(nextEntry.rowKey) ?? state.positionAtIndex?.(nextEntry.rowIndex);
    if (currentMessageBottom === undefined || nextEntryTop === undefined) break;
    if (currentMessageBottom > state.scroll) break;
    if (nextEntryTop > state.scroll + state.scrollLength) break;
    next += 1;
  }
  return next;
}

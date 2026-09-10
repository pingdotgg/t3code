import { LRUCache } from "./lib/lruCache";

const TIMELINE_SCROLL_CACHE_SIZE = 200;
const TIMELINE_SCROLL_POSITION_BYTES = 8;

const timelineScrollPositions = new LRUCache<number>(
  TIMELINE_SCROLL_CACHE_SIZE,
  TIMELINE_SCROLL_CACHE_SIZE * TIMELINE_SCROLL_POSITION_BYTES,
);

export function readTimelineScrollPosition(threadKey: string): number | null {
  return timelineScrollPositions.get(threadKey);
}

export function rememberTimelineScrollPosition(threadKey: string, scrollTop: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return;
  timelineScrollPositions.set(threadKey, scrollTop, TIMELINE_SCROLL_POSITION_BYTES);
}

export function clearTimelineScrollPosition(threadKey: string): void {
  timelineScrollPositions.delete(threadKey);
}

export function clearTimelineScrollStateForTests(): void {
  timelineScrollPositions.clear();
}

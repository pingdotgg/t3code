/**
 * Shared rAF clock for AgentGlyph instances. One loop for the whole page.
 * Callers subscribe only while they need a tick (lerping or fluttering).
 */

type ClockListener = (nowMs: number) => void;

const listeners = new Set<ClockListener>();
let rafId = 0;

function tick(nowMs: number): void {
  for (const listener of listeners) {
    listener(nowMs);
  }
  if (listeners.size > 0) {
    rafId = requestAnimationFrame(tick);
  } else {
    rafId = 0;
  }
}

export function subscribeGlyphClock(listener: ClockListener): () => void {
  listeners.add(listener);
  if (rafId === 0 && typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

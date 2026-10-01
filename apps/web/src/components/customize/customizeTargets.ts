import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { type Rect, unionRect } from "./customizeEdit.logic";

/** The surfaces the mode positions itself around. */
export const SURFACE_SELECTORS = {
  sidebar: '[data-app-sidebar][data-slot="sidebar-container"]',
  header: "[data-chat-header]",
  composer: '[data-slot="composer-shell"]',
} as const;

const EMPTY_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

/** The overlap of two rects, or null when they share no area. */
export function intersectRect(rect: Rect, clip: Rect): Rect | null {
  const left = Math.max(rect.left, clip.left);
  const top = Math.max(rect.top, clip.top);
  const right = Math.min(rect.right, clip.right);
  const bottom = Math.min(rect.bottom, clip.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/**
 * An element's box on screen. Wrappers with `display: contents` have none of
 * their own, so they span their children instead; hidden and pixel-sized
 * elements have none.
 */
export function readElementRect(element: Element): Rect | null {
  const style = getComputedStyle(element);
  if (style.visibility === "hidden") return null;
  if (style.display === "contents") {
    return unionRect([...element.children].map((child) => readElementRect(child) ?? EMPTY_RECT));
  }
  const { left, top, right, bottom } = element.getBoundingClientRect();
  // Hidden form inputs and focus sentinels occupy a pixel or less.
  return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
}

/**
 * The part of an element that is actually on screen: its box clipped by every
 * scrolling or clipping ancestor, such as a thread list scrolled under the
 * sidebar footer, and by the viewport, such as a collapsed sidebar parked
 * off its edge. Null when nothing of it shows.
 */
export function readVisibleRect(element: Element): Rect | null {
  const box = readElementRect(element);
  let rect = box && intersectRect(box, viewportRect());
  for (let ancestor = element.parentElement; rect && ancestor; ancestor = ancestor.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(ancestor);
    if (overflowX === "visible" && overflowY === "visible") continue;
    rect = intersectRect(rect, ancestor.getBoundingClientRect());
  }
  return rect;
}

function viewportRect(): Rect {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Whether an element shows in full, not cut off by a scroller or the viewport. */
export function isFullyVisible(element: Element): boolean {
  const rect = readElementRect(element);
  const visible = rect && readVisibleRect(element);
  return (
    !!rect &&
    !!visible &&
    visible.right - visible.left >= rect.right - rect.left - 1 &&
    visible.bottom - visible.top >= rect.bottom - rect.top - 1
  );
}

export function readSelectorRect(selector: string): Rect | null {
  const element = document.querySelector(selector);
  return element ? readElementRect(element) : null;
}

/** Elements marked with `data-customize-element="surface:id"`. */
export function queryCustomizeElements(root: ParentNode, key: string): Element[] {
  return [...root.querySelectorAll(`[data-customize-element="${key}"]`)];
}

/**
 * Keeps `current` while it still shows; otherwise the shown candidate with the
 * highest positive score, earliest on ties. Candidates are only walked when
 * the current pick is gone.
 */
export function chooseSample<T>(
  current: T | null,
  candidates: () => Iterable<T>,
  isShown: (candidate: T) => boolean,
  score: (candidate: T) => number,
): T | null {
  if (current !== null && isShown(current)) return current;
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates()) {
    if (!isShown(candidate)) continue;
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

/**
 * A sticky pick among elements matching `selector`, such as the sample thread
 * row: the fully visible match with the highest score, kept until it detaches
 * or scrolls out of view so edits don't hop between rows.
 */
export function createSamplePicker(
  selector: string,
  score: (element: Element) => number,
): () => Element | null {
  let current: Element | null = null;
  return () => {
    current = chooseSample(
      current,
      () => document.querySelectorAll(selector),
      (element) => element.isConnected && isFullyVisible(element),
      score,
    );
    return current;
  };
}

// Every live measurement shares one set of listeners and one frame, so a
// scroll costs a single pass however many layers are measuring.
const TICK_MS = 500;
const measurers = new Set<() => void>();
let frame = 0;
let tick = 0;

function runMeasurers() {
  frame = 0;
  for (const measure of measurers) measure();
}

/** Schedules every live measurement for the next frame. */
export function remeasureCustomizeTargets() {
  if (frame === 0 && measurers.size > 0) frame = window.requestAnimationFrame(runMeasurers);
}

function addMeasurer(measure: () => void): () => void {
  if (measurers.size === 0) {
    tick = window.setInterval(remeasureCustomizeTargets, TICK_MS);
    window.addEventListener("resize", remeasureCustomizeTargets);
    document.addEventListener("scroll", remeasureCustomizeTargets, true);
    document.addEventListener("transitionend", remeasureCustomizeTargets, true);
  }
  measurers.add(measure);
  return () => {
    measurers.delete(measure);
    if (measurers.size > 0) return;
    window.clearInterval(tick);
    window.removeEventListener("resize", remeasureCustomizeTargets);
    document.removeEventListener("scroll", remeasureCustomizeTargets, true);
    document.removeEventListener("transitionend", remeasureCustomizeTargets, true);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    frame = 0;
  };
}

/**
 * Re-runs `measure` whenever the page may have moved: resizes, scrolls,
 * transitions, settings writes, and a slow tick for content that changes on
 * its own. State only updates when the serialized result changes, so an idle
 * page doesn't re-render. A new `key` or a settings write measures before
 * paint; a null key stops measuring.
 */
export function useLiveMeasure<T>(measure: () => T, key: string | null): T {
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });
  const [value, setValue] = useState(measure);
  const serializedRef = useRef(JSON.stringify(value));
  const runRef = useRef(() => {
    const next = measureRef.current();
    const serialized = JSON.stringify(next);
    if (serialized === serializedRef.current) return;
    serializedRef.current = serialized;
    setValue(next);
  });

  // Settings such as the interface layout re-render the surfaces in the same
  // commit, so handles follow an edit without waiting for the tick.
  const settings = useClientSettings();
  useLayoutEffect(() => {
    if (key !== null) runRef.current();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A settings write is the trigger.
  }, [key, settings]);

  useEffect(() => (key === null ? undefined : addMeasurer(runRef.current)), [key]);
  return value;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { type Rect, unionRect } from "./customizeEdit.logic";

/** The surfaces the mode positions itself around. */
export const SURFACE_SELECTORS = {
  sidebar: '[data-app-sidebar][data-slot="sidebar-container"]',
  header: "[data-chat-header]",
  composer: '[data-slot="composer-shell"]',
} as const;

const EMPTY_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

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
 * sidebar footer. Null when nothing of it shows.
 */
export function readVisibleRect(element: Element): Rect | null {
  let rect = readElementRect(element);
  for (let ancestor = element.parentElement; rect && ancestor; ancestor = ancestor.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(ancestor);
    if (overflowX === "visible" && overflowY === "visible") continue;
    const clip = ancestor.getBoundingClientRect();
    rect = {
      left: Math.max(rect.left, clip.left),
      top: Math.max(rect.top, clip.top),
      right: Math.min(rect.right, clip.right),
      bottom: Math.min(rect.bottom, clip.bottom),
    };
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return null;
  }
  return rect;
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
 * Re-runs `measure` whenever the page may have moved: resizes, scrolls,
 * transitions, and a slow tick for content that changes on its own. State
 * only updates when the serialized result changes, so an idle page doesn't
 * re-render. A new `key` measures at once; a null key stops measuring.
 */
export function useLiveMeasure<T>(measure: () => T, key: string | null): T {
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  });
  const [value, setValue] = useState(measure);
  const serializedRef = useRef(JSON.stringify(value));
  useEffect(() => {
    if (key === null) return;
    let frame = 0;
    const run = () => {
      frame = 0;
      const next = measureRef.current();
      const serialized = JSON.stringify(next);
      if (serialized === serializedRef.current) return;
      serializedRef.current = serialized;
      setValue(next);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(run);
    };
    schedule();
    const tick = window.setInterval(schedule, 250);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [key]);
  return value;
}

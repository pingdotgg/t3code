import { useCallback, useEffect, useSyncExternalStore } from "react";

/** Most HTML render WebViews alive at once across the app; each is its own JS heap. */
export const HTML_RENDER_LIVE_LIMIT = 3;

/**
 * Hands live WebView slots to inline HTML renders. A render claims a slot when
 * its row scrolls into view and keeps it until another render needs it, so
 * scrolling back and forth does not reload pages. Eviction takes the least
 * recently claimed page that is off screen; a visible page loses its slot only
 * when every live page is visible.
 */
export class HtmlRenderSlots {
  readonly #limit: number;
  readonly #listeners = new Set<() => void>();
  // Claim order, oldest first.
  #live: ReadonlyArray<string> = [];
  readonly #visible = new Set<string>();

  constructor(limit = HTML_RENDER_LIVE_LIMIT) {
    this.#limit = limit;
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly isLive = (key: string) => this.#live.includes(key);

  /** Records whether a render's row is on screen; becoming visible claims a slot. */
  setVisible(key: string, visible: boolean): void {
    if (!visible) {
      this.#visible.delete(key);
      return;
    }
    this.#visible.add(key);
    this.claim(key);
  }

  /** Gives `key` a slot, as on scrolling into view or a tap on its placeholder. */
  claim(key: string): void {
    if (this.#live.includes(key)) return;
    const live = [...this.#live];
    if (live.length >= this.#limit) {
      const offscreen = live.findIndex((other) => !this.#visible.has(other));
      live.splice(offscreen === -1 ? 0 : offscreen, 1);
    }
    this.#set([...live, key]);
  }

  /** Frees a render's slot when its row unmounts. */
  release(key: string): void {
    this.#visible.delete(key);
    if (this.#live.includes(key)) this.#set(this.#live.filter((other) => other !== key));
  }

  #set(live: ReadonlyArray<string>): void {
    this.#live = live;
    for (const listener of this.#listeners) listener();
  }
}

const slots = new HtmlRenderSlots();

/** Whether the render keyed `key` may mount its WebView, and a way to claim one by hand. */
export function useHtmlRenderSlot(key: string, visible: boolean) {
  useEffect(() => slots.setVisible(key, visible), [key, visible]);
  useEffect(() => () => slots.release(key), [key]);
  const live = useSyncExternalStore(
    slots.subscribe,
    useCallback(() => slots.isLive(key), [key]),
  );
  const claim = useCallback(() => slots.claim(key), [key]);
  return { live, claim };
}

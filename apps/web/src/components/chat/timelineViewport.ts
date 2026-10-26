import { registerCommands } from "../../shortcuts/dispatcher";
import {
  eventPathContainsSelector,
  TYPE_TO_FOCUS_EDITABLE_SELECTOR,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
} from "./composerFocusRedirect";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import { createUpwardScrollDetector, isTimelineScrollTarget } from "./timelineScrollTarget";

/**
 * Which thread the mounted timeline list opened on. LegendList's
 * initialScrollAtEnd only measures for that thread; once the same list shows
 * another thread the opening no longer applies, even if it later returns.
 */
export type TimelineListOpening =
  | { readonly mounted: false }
  | { readonly mounted: true; readonly identity: string | null };

export function nextListOpening(
  current: TimelineListOpening,
  listMounted: boolean,
  identity: string,
): TimelineListOpening {
  if (!listMounted) return current.mounted ? { mounted: false } : current;
  if (!current.mounted) return { mounted: true, identity };
  if (current.identity !== null && current.identity !== identity) {
    return { mounted: true, identity: null };
  }
  return current;
}

export type TimelineScrollDirection = "up" | "down";

/**
 * One user attempt to move the timeline. Gestures come from the viewport's own
 * listeners; "command" is a UI action that is about to move it (minimap,
 * citation, composer page keys, scroll to end).
 */
export type TimelineNavigation =
  | { readonly source: "wheel"; readonly direction: TimelineScrollDirection }
  | { readonly source: "touch" }
  | { readonly source: "pointer"; readonly onScrollbar: boolean }
  | { readonly source: "key"; readonly key: string; readonly direction: TimelineScrollDirection }
  | { readonly source: "scroll" }
  | { readonly source: "command"; readonly releasesFollow: boolean };

export interface TimelineViewport {
  readonly scrollNode: HTMLElement;
  /** Every consumer hears the same navigation, in subscription order. */
  readonly subscribe: (listener: (navigation: TimelineNavigation) => void) => () => void;
  readonly navigate: (options: { readonly releasesFollow: boolean }) => void;
  /**
   * Marks our own scrolling (anchoring a turn, restoring a position) so the
   * upward scroll it causes is not read as the user's. Returns the release.
   */
  readonly holdProgrammaticScroll: () => () => void;
  /** Follow announces letting go, so the list can remember it is reading history. */
  readonly followReleased: () => void;
  readonly onFollowReleased: (listener: () => void) => () => void;
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);

/**
 * Owns the timeline scroll node's input listeners for as long as the node is
 * mounted, and turns them into one navigation signal.
 */
export function attachTimelineViewport(scrollNode: HTMLElement): TimelineViewport & {
  readonly dispose: () => void;
} {
  const listeners = new Set<(navigation: TimelineNavigation) => void>();
  const followReleasedListeners = new Set<() => void>();
  let programmaticHolds = 0;
  const emit = (navigation: TimelineNavigation) => {
    for (const listener of listeners) listener(navigation);
  };
  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY)) return;
    emit({ source: "wheel", direction: event.deltaY < 0 ? "up" : "down" });
  };
  const handleTouchMove = () => emit({ source: "touch" });
  // Scrollbar drags produce no wheel/touch events; they are the only
  // pointerdowns whose target is the scroll node itself rather than a row.
  const handlePointerDown = (event: PointerEvent) =>
    emit({ source: "pointer", onScrollbar: event.target === scrollNode });
  // Clicking message text can leave DOM focus on body, and keyboard scrolling
  // bypasses wheel and pointer events, so scroll keys are heard app-wide.
  const handleKeyDown = (event: KeyboardEvent, consumed: boolean) => {
    const direction = UP_KEYS.has(event.key) ? "up" : DOWN_KEYS.has(event.key) ? "down" : null;
    if (
      direction === null ||
      consumed ||
      !(event.target instanceof Node) ||
      (!scrollNode.contains(event.target) &&
        event.target !== document.body &&
        event.target !== document.documentElement) ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
      document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) ||
      (scrollNode.contains(event.target) &&
        !isTimelineScrollTarget(event.target, scrollNode, direction === "up" ? -1 : 1))
    ) {
      return;
    }
    emit({ source: "key", key: event.key, direction });
  };
  // Input inside an embedded frame reaches none of the listeners above, but
  // its scroll still chains out to the timeline.
  const scrolledUp = createUpwardScrollDetector({
    top: scrollNode.scrollTop,
    height: scrollNode.scrollHeight,
  });
  const handleScroll = () => {
    if (
      scrolledUp({
        top: scrollNode.scrollTop,
        height: scrollNode.scrollHeight,
        programmatic: programmaticHolds > 0,
      }) &&
      // LegendList updates its scroll state on the next animation frame.
      resolveTimelineIsAtEnd({
        contentLength: scrollNode.scrollHeight,
        scroll: scrollNode.scrollTop,
        scrollLength: scrollNode.clientHeight,
      }) === false
    ) {
      emit({ source: "scroll" });
    }
  };
  scrollNode.addEventListener("scroll", handleScroll, { passive: true });
  scrollNode.addEventListener("wheel", handleWheel, { passive: true });
  scrollNode.addEventListener("touchmove", handleTouchMove, { passive: true });
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
  const unregisterKeyDown = registerCommands({}, { observe: handleKeyDown });
  return {
    scrollNode,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate: ({ releasesFollow }) => emit({ source: "command", releasesFollow }),
    holdProgrammaticScroll: () => {
      programmaticHolds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        programmaticHolds -= 1;
      };
    },
    followReleased: () => {
      for (const listener of followReleasedListeners) listener();
    },
    onFollowReleased: (listener) => {
      followReleasedListeners.add(listener);
      return () => followReleasedListeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      followReleasedListeners.clear();
      scrollNode.removeEventListener("scroll", handleScroll);
      scrollNode.removeEventListener("wheel", handleWheel);
      scrollNode.removeEventListener("touchmove", handleTouchMove);
      scrollNode.removeEventListener("pointerdown", handlePointerDown);
      unregisterKeyDown();
    },
  };
}

/**
 * Whether a navigation can carry the viewport away from the live edge. A spurious
 * release while pinned never re-arms, so streaming stops following. Downward input
 * counts only outside the end band: streaming growth makes isAtEnd flicker false
 * for a frame, and a gesture then must not release follow.
 */
export function navigationReleasesFollow(
  navigation: TimelineNavigation,
  viewport: { readonly contentScrollsUp: () => boolean; readonly awayFromEnd: () => boolean },
): boolean {
  switch (navigation.source) {
    case "wheel":
      return navigation.direction === "up" && viewport.contentScrollsUp();
    case "key":
      return navigation.direction === "up" ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "pointer":
      return navigation.onScrollbar ? viewport.contentScrollsUp() : viewport.awayFromEnd();
    case "touch":
      // Touch direction is not observable; an upward flick leaves the end
      // band within its first few events.
      return viewport.awayFromEnd();
    case "scroll":
      return true;
    case "command":
      return navigation.releasesFollow;
  }
}

/**
 * Whether the timeline keeps the live end in view. An anchored new turn is
 * following with an anchor present (the anchor lives with the thread's
 * timeline state). `atEnd` only matters once released: while following, the
 * list is at its end by definition.
 */
export type TimelineFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TimelineFollowEvent =
  | { readonly type: "navigated" }
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TimelineFollow = { mode: "following" };

export function initialTimelineFollow(followEnd: boolean): TimelineFollow {
  return followEnd ? FOLLOWING : { mode: "released", atEnd: false };
}

export function transitionTimelineFollow(
  state: TimelineFollow,
  event: TimelineFollowEvent,
): TimelineFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // Navigating away while still at the end stays released until the list
      // reports leaving and returning, so a scroll key at the end cannot re-arm.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, the list leaves the end band for a frame on every
      // streamed chunk before the follow scroll catches up.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
  }
}

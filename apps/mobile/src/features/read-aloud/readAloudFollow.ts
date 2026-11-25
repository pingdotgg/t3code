/** After the user scrolls, following waits this long and for the word to be back in view. */
const FOLLOW_PAUSE_MS = 3_000;
/** The word stays in the middle of the feed; leaving that band scrolls it to 40%. As on the web. */
const FOLLOW_BAND = { top: 0.2, bottom: 0.8, target: 0.4 };

/** A vertical span in window coordinates. */
export interface ReadAloudSpan {
  readonly top: number;
  readonly height: number;
}

/** The thread feed read aloud scrolls: its visible area and a relative scroll. */
export interface ReadAloudFeed {
  readonly measure: (callback: (view: ReadAloudSpan) => void) => void;
  readonly scrollBy: (delta: number) => void;
}

/**
 * How far to scroll so `target` sits in the follow band of `view`, or 0. While the user's own
 * scroll is recent, or has left the word out of view, following waits and never pulls them back.
 */
export function readAloudFollowDelta(input: {
  readonly target: ReadAloudSpan;
  readonly view: ReadAloudSpan;
  readonly userScrolledAt: number | null;
  readonly now: number;
}): { readonly delta: number; readonly resumed: boolean } {
  const { target, view, userScrolledAt, now } = input;
  const bottom = target.top + target.height;
  if (userScrolledAt !== null) {
    if (now - userScrolledAt < FOLLOW_PAUSE_MS) return { delta: 0, resumed: false };
    if (bottom < view.top || target.top > view.top + view.height)
      return { delta: 0, resumed: false };
  }
  const inBand =
    target.top >= view.top + view.height * FOLLOW_BAND.top &&
    bottom <= view.top + view.height * FOLLOW_BAND.bottom;
  return {
    delta: inBand ? 0 : target.top - (view.top + view.height * FOLLOW_BAND.target),
    resumed: true,
  };
}

let feed: ReadAloudFeed | null = null;
let userScrolledAt: number | null = null;
let followingId: string | null = null;

/** The mounted thread feed; read aloud only reads replies on screen, so there is one. */
export function registerReadAloudFeed(next: ReadAloudFeed) {
  feed = next;
  return () => {
    if (feed === next) feed = null;
  };
}

/** The user dragged the feed; following pauses so it does not fight them. */
export function markReadAloudUserScroll() {
  userScrolledAt = Date.now();
}

/**
 * Scrolls the feed so the line read in message `id`, in window coordinates, stays in view.
 * Starting another message follows at once, whatever the user scrolled before.
 */
export function followReadAloud(id: string, target: ReadAloudSpan) {
  if (id !== followingId) {
    followingId = id;
    userScrolledAt = null;
  }
  const current = feed;
  current?.measure((view) => {
    const next = readAloudFollowDelta({ target, view, userScrolledAt, now: Date.now() });
    if (!next.resumed) return;
    userScrolledAt = null;
    if (Math.abs(next.delta) >= 1) current.scrollBy(next.delta);
  });
}

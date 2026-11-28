/** After the user scrolls, following waits this long and for the word to be back in view. */
const FOLLOW_PAUSE_MS = 3_000;
/** The word stays in the middle of the feed; leaving that band scrolls it to 40%. As on the web. */
const FOLLOW_BAND = { top: 0.2, bottom: 0.8, target: 0.4 };

/** A vertical span in window coordinates. */
export interface ReadAloudSpan {
  readonly top: number;
  readonly height: number;
}

/** The thread feed read aloud scrolls: its visible area, scroll offset, and a relative scroll. */
export interface ReadAloudFeed {
  readonly measure: (callback: (view: ReadAloudSpan) => void) => void;
  readonly offset: () => number;
  readonly scrollBy: (delta: number) => void;
}

/** Which way the word read lies when it is outside the feed's visible area. */
export type ReadAloudAway = "above" | "below";

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

/**
 * Where `target`, measured at feed scroll `offset`, lies at feed scroll `now`: outside `view`
 * above or below it, or null while any of it shows.
 */
export function readAloudAway(input: {
  readonly target: ReadAloudSpan;
  readonly offset: number;
  readonly now: number;
  readonly view: ReadAloudSpan;
}): ReadAloudAway | null {
  const top = input.target.top - (input.now - input.offset);
  if (top + input.target.height < input.view.top) return "above";
  if (top > input.view.top + input.view.height) return "below";
  return null;
}

let feed: ReadAloudFeed | null = null;
let userScrolledAt: number | null = null;
let followingId: string | null = null;
// The last line read and where the feed was scrolled then, so scrolling can tell if it left view.
let lastRead: {
  readonly id: string;
  readonly target: ReadAloudSpan;
  readonly offset: number;
} | null = null;
let lastView: ReadAloudSpan | null = null;
let away: { readonly id: string; readonly side: ReadAloudAway } | null = null;
const awayListeners = new Set<() => void>();

function updateAway() {
  const side =
    lastRead && lastView && feed
      ? readAloudAway({ ...lastRead, now: feed.offset(), view: lastView })
      : null;
  const next = lastRead && side ? { id: lastRead.id, side } : null;
  if (next?.id === away?.id && next?.side === away?.side) return;
  away = next;
  for (const listener of awayListeners) listener();
}

/** The mounted thread feed; read aloud only reads replies on screen, so there is one. */
export function registerReadAloudFeed(next: ReadAloudFeed) {
  feed = next;
  return () => {
    if (feed !== next) return;
    feed = null;
    lastRead = null;
    updateAway();
  };
}

/** The feed scrolled, so the line read may have left or come back into view. */
export function readAloudFeedScrolled() {
  if (lastRead) updateAway();
}

/** The message whose line read is scrolled out of view, and which way it lies, or null. */
export function getReadAloudAway() {
  return away;
}

export function subscribeReadAloudAway(listener: () => void) {
  awayListeners.add(listener);
  return () => {
    awayListeners.delete(listener);
  };
}

/** Scrolls the line read back into view and follows it again, as after starting to read. */
export function scrollToReadAloud() {
  const current = feed;
  if (!current || !lastRead || !lastView) return;
  userScrolledAt = null;
  const top = lastRead.target.top - (current.offset() - lastRead.offset);
  current.scrollBy(top - (lastView.top + lastView.height * FOLLOW_BAND.target));
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
    lastRead = { id, target, offset: current.offset() };
    lastView = view;
    const next = readAloudFollowDelta({ target, view, userScrolledAt, now: Date.now() });
    if (next.resumed) {
      userScrolledAt = null;
      if (Math.abs(next.delta) >= 1) current.scrollBy(next.delta);
    }
    updateAway();
  });
}

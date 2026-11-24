export const THREAD_FEED_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;

// Re-arm end following only at the end itself: a release short of it, such as pulling to
// load earlier activity, must not snap back to the end.
export const THREAD_FEED_MAINTAIN_SCROLL_AT_END_THRESHOLD = 0;

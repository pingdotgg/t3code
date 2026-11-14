/** Shared by the sidebar slide and pane motion: elements that go straight from where they showed
 * to where they land while the box around them changes size. */

/** `end` follows a right-anchored element, `center` a centered lane, anything else its left edge. */
export function slideTrackEdge(
  element: HTMLElement,
  track = element.dataset.sidebarSlideTrack,
): number {
  const rect = element.getBoundingClientRect();
  if (track === "end") return rect.right;
  return track === "center" ? (rect.left + rect.right) / 2 : rect.left;
}

let sidebarSlidePending = false;

/** Between a sidebar toggle's commit and the slide it starts: the panes' width change is the
 * sidebar's, which they animate with instead of following it 1:1. */
export const sidebarSlideStarting = () => sidebarSlidePending;

export function markSidebarSlide(pending: boolean): void {
  sidebarSlidePending = pending;
}

/** After the app's resize observers commit what the new width moves (the chat lanes), before paint.
 * Called from inside a resize observer, it must watch `targets` deeper than what that one reported,
 * or the browser holds it for the next frame. */
export function afterResizeObservers(
  callback: () => void,
  targets: Iterable<Element> = [document.documentElement],
): void {
  if (typeof ResizeObserver === "undefined") {
    window.requestAnimationFrame(callback);
    return;
  }
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- No React state here: a fresh observer is delivered after the shared one, so it sees what that one committed.
  const observer = new ResizeObserver(() => {
    observer.disconnect();
    callback();
  });
  for (const target of targets) observer.observe(target);
}

/** Lets `elements` show past `root`'s box: `root` and the clipping, non-scrolling boxes between
 * them stop clipping until the returned undo; the caller clips `root` by its shape meanwhile. */
export function liftSlideClips(root: HTMLElement, elements: Iterable<HTMLElement>): () => void {
  if (root.scrollLeft !== 0 || root.scrollTop !== 0) return () => {};
  const lifted = new Set<HTMLElement>([root]);
  const walked = new Set<HTMLElement>();
  for (const element of elements) {
    for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
      if (walked.has(node)) break;
      walked.add(node);
      const { overflowX, overflowY } = getComputedStyle(node);
      const clips = overflowX === "hidden" || overflowX === "clip";
      const scrolls = overflowY === "auto" || overflowY === "scroll";
      if (clips && !scrolls && node.scrollLeft === 0 && node.scrollTop === 0) lifted.add(node);
    }
  }
  for (const node of lifted) node.style.overflow = "visible";
  return () => {
    for (const node of lifted) node.style.removeProperty("overflow");
  };
}

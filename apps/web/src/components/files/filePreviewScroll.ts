import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

import { useRightPanelStore } from "~/rightPanelStore";

const MAX_POSITIONS = 200;

export interface FileScrollAnchor {
  line: number;
  /** Pixels from the top edge of the view down to the line. */
  offset: number;
}

export interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
  /** The path's code view offset when it last unmounted, restored when it is shown again. */
  scrollTop: number;
  /** The line at the top of that view; wrapped lines make the same offset a different line. */
  anchor: FileScrollAnchor | null;
  scrollContainer: HTMLElement | null;
  restoreFrameId: number | null;
}

interface PreviewScroll {
  /** Identifies the scroll container in the next mount of the same view. */
  className: string;
  top: number;
  left: number;
}

// Thread switches unmount the preview, so positions outlive it; only the most recent are kept.
const revealStates = new Map<string, FileRevealState>();
const previewScrolls = new Map<string, PreviewScroll>();

function retain<Value>(positions: Map<string, Value>, key: string, value: Value): Value {
  positions.delete(key);
  positions.set(key, value);
  if (positions.size > MAX_POSITIONS) {
    for (const oldest of positions.keys()) {
      positions.delete(oldest);
      break;
    }
  }
  return value;
}

/** One key per file tab: a thread's panel holds at most one surface for a path or attachment. */
export const filePreviewScrollKey = (
  environmentId: string,
  threadId: string,
  surfaceId: string,
): string => `${environmentId}\u0000${threadId}\u0000${surfaceId}`;

export function fileRevealState(key: string): FileRevealState {
  return (
    revealStates.get(key) ??
    retain(revealStates, key, {
      frameId: null,
      cancelGuard: null,
      handledRequestId: null,
      latestRequestId: null,
      scrollTop: 0,
      anchor: null,
      scrollContainer: null,
      restoreFrameId: null,
    })
  );
}

/** Marks the state as most recently used once its view has saved an offset. */
export function retainFileRevealState(key: string, state: FileRevealState): void {
  retain(revealStates, key, state);
}

// Reveal ids restart at one for each new tab, so a closed tab's handled id must not outlive it.
useRightPanelStore.subscribe((next, previous) => {
  if (next.byThreadKey === previous.byThreadKey) return;
  for (const [threadKey, before] of Object.entries(previous.byThreadKey)) {
    const after = next.byThreadKey[threadKey];
    if (after === before) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef) continue;
    for (const surface of before.surfaces) {
      if (surface.kind !== "file" || after?.surfaces.some((entry) => entry.id === surface.id)) {
        continue;
      }
      const state = revealStates.get(
        filePreviewScrollKey(threadRef.environmentId, threadRef.threadId, surface.id),
      );
      if (!state) continue;
      state.handledRequestId = null;
      state.latestRequestId = null;
    }
  }
});

const RESTORE_MAX_ATTEMPTS = 30;
/** These restore their own position: the code view by line reveal state, the PDF viewer by page. */
const OWN_RESTORE_SELECTOR = ".file-preview-virtualizer, [data-pdf-scroll]";

const scrollsVertically = (element: Element): boolean =>
  element.scrollHeight > element.clientHeight &&
  /auto|scroll/.test(getComputedStyle(element).overflowY);

/**
 * Remembers where the preview inside `wrapper` is scrolled and, when `restore` is set, returns a
 * remounted view to that offset. Returns the cleanup.
 */
export function trackPreviewScroll(wrapper: HTMLElement, key: string, restore: boolean) {
  const saved = restore ? previewScrolls.get(key) : undefined;
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.matches(OWN_RESTORE_SELECTOR)) return;
    // A scrolled code block or cell inside the view is not the reading position.
    for (let parent = target.parentElement; parent && parent !== wrapper;) {
      if (scrollsVertically(parent)) return;
      parent = parent.parentElement;
    }
    retain(previewScrolls, key, {
      className: target.className,
      top: target.scrollTop,
      left: target.scrollLeft,
    });
  };
  wrapper.addEventListener("scroll", onScroll, { capture: true, passive: true });

  const selector = (saved?.className ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => `.${CSS.escape(name)}`)
    .join("");
  let frameId: number | null = null;
  let attempts = 0;
  const observer = new MutationObserver(() => {
    frameId ??= requestAnimationFrame(attemptRestore);
  });
  const stopRestore = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    observer.disconnect();
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      wrapper.removeEventListener(type, stopRestore, true);
    }
  };
  function attemptRestore() {
    frameId = null;
    if (!saved) return;
    const scroller = Array.from(wrapper.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.className === saved.className,
    );
    // The view is still loading; the next mutation tries again.
    if (!scroller) return;
    // Wait for the content to be laid out so the offset is not clamped.
    const fits = scroller.scrollHeight - scroller.clientHeight >= saved.top;
    attempts += 1;
    if (!fits && attempts < RESTORE_MAX_ATTEMPTS) {
      frameId = requestAnimationFrame(attemptRestore);
      return;
    }
    stopRestore();
    scroller.scrollTo({ top: saved.top, left: saved.left, behavior: "instant" });
  }
  if (saved && selector) {
    observer.observe(wrapper, { childList: true, subtree: true });
    // The reader's own scrolling wins over a restore that has not happened yet.
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      wrapper.addEventListener(type, stopRestore, { capture: true, passive: true });
    }
    frameId = requestAnimationFrame(attemptRestore);
  }

  return () => {
    wrapper.removeEventListener("scroll", onScroll, true);
    stopRestore();
  };
}

const documentScrolls = new Map<string, { x: number; y: number }>();

/** The scroll position a sandboxed HTML preview last reported, keyed by its document id. */
export const documentScroll = {
  get: (documentId: string) => documentScrolls.get(documentId),
  set: (documentId: string, scroll: { x: number; y: number }) =>
    void retain(documentScrolls, documentId, scroll),
};

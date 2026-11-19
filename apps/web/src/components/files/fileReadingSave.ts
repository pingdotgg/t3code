import type { FilePreviewScroll } from "@t3tools/shared/htmlRender";
import { useEffect, useState } from "react";

import type { PdfViewState } from "./PdfViewer";
import {
  createFileReadingStore,
  type FileReadingKey,
  type HeldPosition,
  type ReadingPosition,
} from "./fileReadingStore";

export type { FileReadingKey } from "./fileReadingStore";

// Kept apart from the panel shell so the chat view's PDF frame does not load Pierre's file classes.
const SAVE_DELAY_MS = 300;

export const readings = createFileReadingStore({
  storage: () => window.localStorage,
  now: () => Date.now(),
});

/** A position waiting out the save delay, written early on unmount and pagehide. */
export class PendingPosition {
  private held: HeldPosition | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly file: FileReadingKey,
    private readonly onSettle?: () => void,
  ) {}

  hold(position: ReadingPosition): void {
    if (this.held !== null && this.held.position.view !== position.view) this.held.flush();
    this.held = readings.holdPosition(this.file, position);
    this.clearTimer();
    this.schedule();
  }

  /** Starts the settle delay without a position, unless one is already waiting. */
  touch(): void {
    if (this.timer === null) this.schedule();
  }

  write(position: ReadingPosition): void {
    this.hold(position);
    this.flush();
  }

  get waiting(): boolean {
    return this.timer !== null;
  }

  readonly flush = (): void => {
    this.clearTimer();
    this.held?.flush();
    this.held = null;
  };

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.flush();
      this.onSettle?.();
    }, SAVE_DELAY_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Flushes `pending` when the page hides or the caller unmounts. */
function useFlushOnExit(pending: PendingPosition | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the debounced position to localStorage when the page hides or the view unmounts
  useEffect(() => {
    if (pending === null) return;
    window.addEventListener("pagehide", pending.flush);
    return () => {
      window.removeEventListener("pagehide", pending.flush);
      pending.flush();
    };
  }, [pending]);
}

const FIRST_PAGE: PdfViewState = { page: 0, offset: 0, zoom: null, left: 0 };

/** Whether two PDF views show the same spot; an offset measured at another width is scaled. */
function samePdfView(next: PdfViewState, view: PdfViewState) {
  const scale = next.width !== undefined && view.width !== undefined ? next.width / view.width : 1;
  return (
    next.page === view.page &&
    next.zoom === view.zoom &&
    next.left === view.left &&
    Math.abs(next.offset - view.offset * scale) <= 1
  );
}

/** PDF.js view state seeded from and saved to the reading store when `file` is given. */
export function usePdfReadingView(file: FileReadingKey | undefined) {
  const [pending] = useState(() => (file === undefined ? null : new PendingPosition(file)));
  const [view, setView] = useState<PdfViewState>(() => {
    const saved = file === undefined ? null : readings.readPosition(file, "pdf");
    if (saved === null) return FIRST_PAGE;
    const { view: _view, ...state } = saved;
    return state;
  });
  useFlushOnExit(pending);
  const changeView = (next: PdfViewState) => {
    if (samePdfView(next, view)) return;
    setView(next);
    pending?.hold({ view: "pdf", ...next });
  };
  return [view, changeView] as const;
}

/**
 * An HTML page's saved place: `seed` starts the frame's restore, and `save` keeps a scroll the
 * page reported, debounced and skipped when unchanged. `FrameReading` decides what to save.
 */
export function useFramePlace(file: FileReadingKey | undefined) {
  const [pending] = useState(() => (file === undefined ? null : new PendingPosition(file)));
  const [place] = useState(() => {
    const saved = pending === null ? null : readings.readPosition(pending.file, "offset");
    let last: FilePreviewScroll | null = saved === null ? null : { x: saved.left, y: saved.top };
    return {
      seed: last,
      save(scroll: FilePreviewScroll) {
        if (pending === null || (last?.x === scroll.x && last.y === scroll.y)) return;
        last = scroll;
        pending.hold({ view: "offset", top: Math.max(0, scroll.y), left: Math.max(0, scroll.x) });
      },
    };
  });
  useFlushOnExit(pending);
  return place;
}

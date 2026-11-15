import { useEffect, useState } from "react";

import type { PdfViewState } from "./PdfViewer";
import {
  createFileReadingStore,
  type FileReadingKey,
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
  private position: ReadingPosition | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: FileReadingKey,
    private readonly onSettle?: () => void,
  ) {}

  hold(position: ReadingPosition): void {
    this.position = position;
    this.clearTimer();
    this.schedule();
  }

  /** Starts the settle delay without a position, unless one is already waiting. */
  touch(): void {
    if (this.timer === null) this.schedule();
  }

  write(position: ReadingPosition): void {
    this.position = position;
    this.flush();
  }

  get waiting(): boolean {
    return this.timer !== null;
  }

  readonly flush = (): void => {
    this.clearTimer();
    if (this.position !== null) readings.writePosition(this.file, this.position);
    this.position = null;
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

const FIRST_PAGE: PdfViewState = { page: 0, offset: 0, zoom: null, left: 0 };

/** PDF.js view state seeded from and saved to the reading store when `file` is given. */
export function usePdfReadingView(file: FileReadingKey | undefined) {
  const [pending] = useState(() => (file === undefined ? null : new PendingPosition(file)));
  const [view, setView] = useState<PdfViewState>(() => {
    const saved = file === undefined ? null : readings.readPosition(file, "pdf");
    return saved === null
      ? FIRST_PAGE
      : { page: saved.page, offset: saved.offset, zoom: saved.zoom, left: saved.left };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the debounced PDF position to localStorage when the page hides or the document unmounts
  useEffect(() => {
    if (pending === null) return;
    window.addEventListener("pagehide", pending.flush);
    return () => {
      window.removeEventListener("pagehide", pending.flush);
      pending.flush();
    };
  }, [pending]);
  const changeView = (next: PdfViewState) => {
    // PdfViewer reports its own restore; saving that again would renew the entry on every open.
    if (
      next.page === view.page &&
      next.offset === view.offset &&
      next.zoom === view.zoom &&
      next.left === view.left
    ) {
      return;
    }
    setView(next);
    pending?.hold({ view: "pdf", ...next });
  };
  return [view, changeView] as const;
}

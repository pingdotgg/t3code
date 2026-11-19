// How an HTML file's frame finds and keeps the reader's place. Each document a frame shows has
// its own phase; the frame component posts, saves and reveals what these steps return.
import type { FilePreviewScroll } from "@t3tools/shared/htmlRender";

/** How often a restored page that is still short of its place is asked again. */
export const FRAME_RETRY_MS = 100;
// A page may still grow for a while after it takes a restore; then the reader's scrolls count.
const HOLD_RETRIES = 10;

type Phase =
  /** Before its load; its reports wait for the load to decide. */
  | { readonly name: "opening" }
  | { readonly name: "restoring"; readonly target: FilePreviewScroll }
  /** Took the restore; a report or check short of the target asks again until the hold ends. */
  | { readonly name: "holding"; readonly target: FilePreviewScroll; readonly retries: number }
  | { readonly name: "saving" }
  /** The frame loaded another document, such as a linked page; nothing it reports is kept. */
  | { readonly name: "away" };

interface FrameDocument {
  phase: Phase;
  loads: number;
  /** The document's last reported scroll. */
  at: FilePreviewScroll | null;
  /** The place last sent to it. */
  sent: FilePreviewScroll | null;
  /** A timed-out swap showed it before its load. */
  early: boolean;
  /** A `retry` is due; one chain of them holds the document, however often it is restored. */
  retrying: boolean;
}

/** The revision on screen, or the one loading beneath it. */
export type FrameRole = "shown" | "next";

export type FrameAction =
  | { readonly type: "restore"; readonly scroll: FilePreviewScroll }
  /** Paint the next revision for two frames, then call `swap`. */
  | { readonly type: "reveal" }
  /** Show the next revision in place of the one on screen. */
  | { readonly type: "show" }
  | { readonly type: "save"; readonly scroll: FilePreviewScroll }
  /** Call `retry` for this document after `FRAME_RETRY_MS`. */
  | { readonly type: "retry" };

const ORIGIN: FilePreviewScroll = { x: 0, y: 0 };
const SAVING: Phase = { name: "saving" };
const REVEAL: FrameAction = { type: "reveal" };
const SHOW: FrameAction = { type: "show" };
const RETRY: FrameAction = { type: "retry" };

// A page grows down after it loads; one with no room to the side never reaches a sideways place.
const short = (scroll: FilePreviewScroll, target: FilePreviewScroll) => scroll.y < target.y - 1;
const same = (left: FilePreviewScroll, right: FilePreviewScroll) =>
  left.x === right.x && left.y === right.y;

/** The reader's place in one HTML file across the frame's documents, keyed by their windows. */
export class FrameReading<W extends object> {
  /** The saved place, then each report accepted from the document on screen. */
  private place: FilePreviewScroll | null;
  /** A revision without the scroll script stalled a swap, so later ones show on load. */
  private noBridge = false;
  private readonly documents = new WeakMap<W, FrameDocument>();

  constructor(seed: FilePreviewScroll | null) {
    this.place = seed;
  }

  load(frame: W, role: FrameRole): FrameAction[] {
    const document = this.document(frame);
    if (++document.loads > 1) {
      document.phase = { name: "away" };
      return [];
    }
    if (document.phase.name !== "opening") return [];
    if (this.place === null) {
      document.phase = SAVING;
      return role === "next" ? [REVEAL] : [];
    }
    if (role === "next") {
      return [this.restore(document, this.place), ...(this.noBridge ? [REVEAL] : [])];
    }
    // A page a timed-out swap showed before its load keeps where the reader took it meanwhile.
    if (document.early && document.at !== null) return this.accept(document, document.at);
    return [this.restore(document, this.place)];
  }

  report(frame: W, role: FrameRole, scroll: FilePreviewScroll): FrameAction[] {
    const document = this.document(frame);
    const { phase } = document;
    if (phase.name === "away") return [];
    this.noBridge = false;
    document.at = scroll;
    if (phase.name === "holding") {
      if (short(scroll, phase.target)) return [{ type: "restore", scroll: phase.target }];
      document.phase = SAVING;
      return [];
    }
    if (role === "shown" && (phase.name === "saving" || this.place === null)) {
      return this.accept(document, scroll);
    }
    return [];
  }

  /** The document scrolled to the place it was sent. */
  restored(frame: W, role: FrameRole): FrameAction[] {
    const document = this.document(frame);
    if (document.phase.name === "away") return [];
    this.noBridge = false;
    if (document.phase.name !== "restoring") return [];
    document.phase = { name: "holding", target: document.phase.target, retries: 0 };
    const retry = document.retrying ? [] : [RETRY];
    document.retrying = true;
    return role === "next" ? [...retry, REVEAL] : retry;
  }

  retry(frame: W): FrameAction[] {
    const document = this.documents.get(frame);
    if (document === undefined) return [];
    const { phase } = document;
    if (phase.name === "holding" && phase.retries < HOLD_RETRIES) {
      document.phase = { ...phase, retries: phase.retries + 1 };
      // A page that did not move sends no report.
      return short(document.at ?? ORIGIN, phase.target)
        ? [{ type: "restore", scroll: phase.target }, RETRY]
        : [RETRY];
    }
    if (phase.name === "holding") document.phase = SAVING;
    document.retrying = false;
    return [];
  }

  /** Just before the next revision shows, it gets the place if it was never sent or moved since. */
  swap(frame: W): FrameAction[] {
    const document = this.documents.get(frame);
    if (
      document === undefined ||
      document.phase.name === "away" ||
      this.place === null ||
      (document.sent !== null && same(document.sent, this.place))
    ) {
      return [SHOW];
    }
    // A page that never took a restore cannot say it took this one either.
    const waits = document.phase.name !== "restoring";
    return waits
      ? [this.restore(document, this.place)]
      : [this.restore(document, this.place), SHOW];
  }

  /** The next revision was shown before it took a restore. */
  swapTimedOut(frame: W | null): void {
    const document = frame === null ? undefined : this.document(frame);
    if (document !== undefined) document.early = true;
    const phase = document?.phase.name;
    if (phase === undefined || phase === "opening" || phase === "restoring") this.noBridge = true;
  }

  private document(frame: W): FrameDocument {
    let document = this.documents.get(frame);
    if (document === undefined) {
      document = {
        phase: { name: "opening" },
        loads: 0,
        at: null,
        sent: null,
        early: false,
        retrying: false,
      };
      this.documents.set(frame, document);
    }
    return document;
  }

  private restore(document: FrameDocument, target: FilePreviewScroll): FrameAction {
    document.phase = { name: "restoring", target };
    document.sent = target;
    return { type: "restore", scroll: target };
  }

  private accept(document: FrameDocument, scroll: FilePreviewScroll): FrameAction[] {
    document.phase = SAVING;
    this.place = scroll;
    return [{ type: "save", scroll }];
  }
}

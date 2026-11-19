// The container keeps the place of the DOM viewer it holds: by item for lists of blocks, else by
// offset; table rows restore through the viewer's own reveal (`rowLine`), media by playback time.
// A frame or a canvas viewer with its own state takes an adapter instead: `FrameReading` for
// HTML pages, `usePdfReadingView` for PDF.js, the source tracker for Pierre's code view.
import { useState, useSyncExternalStore } from "react";

import { observeResize } from "~/lib/observeResize";

import { PendingPosition, readings } from "./fileReadingSave";
import {
  fileReadingId,
  type FileReadingKey,
  type ReadingPosition,
  type ReadingPositionOf,
  type ReadingView,
} from "./fileReadingStore";

const HOLD_MS = 1000;
/** How long a viewer that loads may take to show the scroller of a saved place. */
const LOOK_MS = 30_000;
/** A control may switch the viewer inside the container, such as a sheet or a mode. */
const INPUT_LOOK_MS = 2000;
/** Sheet tabs, sheet pickers and mode toggles are buttons; a key or click in the content is not. */
const VIEWER_SWITCH = "button";
const CAPTURE_ATTEMPTS = 8;
/** Playback this close to where it started has not moved; a seek may land a little off. */
const SAME_TIME_S = 0.01;

type SourcePosition = ReadingPositionOf<"source">;
type RenderedPosition = ReadingPositionOf<"rendered">;
type OffsetPosition = ReadingPositionOf<"offset">;

export interface ScrollTarget {
  readonly top: number;
  readonly left?: number;
}

export interface ViewGeometry<P extends ReadingPosition> {
  /**
   * Where the scroller shows `position`, or null until the content can place it. `settled` turns
   * true when the first second of a restore has passed.
   */
  target(position: P, settled: boolean): ScrollTarget | null;
  /** The position at the viewport top, or null while the content cannot tell. */
  capture(): P | null;
}

/** A viewer's main scroller and how to read and place its position. */
export interface Binding<P extends ReadingPosition = ReadingPosition> {
  readonly element: HTMLElement;
  readonly geometry: ViewGeometry<P>;
}

interface Restore {
  readonly element: HTMLElement;
  readonly target: (settled: boolean) => ScrollTarget | null;
  readonly holdUntil: number;
  readonly until: number;
  stopResize: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Restores and saves the position of the scrollers `bind` accepts under `root`. Only scrolls that
 * follow reader input on `root` are saved, so restores, reveals and layout resets never overwrite
 * a saved position.
 */
export class ReadingTracker {
  private state: "idle" | "holding" | "armed" = "idle";
  private frame: number | null = null;
  private restoring: Restore | null = null;
  /** A scrollbar drag can pause longer than the save delay without a new pointerdown. */
  private pointerDown = false;
  private readonly pending: PendingPosition;
  /** The newest position restored, captured or recorded. */
  anchor: ReadingPosition | null = null;

  constructor(
    private readonly root: HTMLElement,
    file: FileReadingKey,
    private readonly bind: (scrolled: HTMLElement) => Binding | null,
    private readonly onInput?: (event: Event) => void,
  ) {
    this.pending = new PendingPosition(file, () => {
      if (this.state === "armed" && !this.pointerDown) this.state = "idle";
    });
    root.addEventListener("wheel", this.arm, { passive: true, capture: true });
    root.addEventListener("touchstart", this.arm, { passive: true, capture: true });
    root.addEventListener("pointerdown", this.press, { passive: true, capture: true });
    root.addEventListener("keydown", this.arm, { capture: true });
    // Scroll does not bubble, but its capture phase reaches every ancestor.
    root.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    window.addEventListener("pointerup", this.release, true);
    window.addEventListener("pointercancel", this.release, true);
    window.addEventListener("pagehide", this.pending.flush);
  }

  /**
   * Places `position` every frame for a second, then on resizes of the scroller and its content
   * until `until`. Reader input ends it.
   */
  restore<P extends ReadingPosition>(binding: Binding<P>, position: P, until = 0): void {
    this.endRestore();
    this.anchor = position;
    this.state = "holding";
    const holdUntil = performance.now() + HOLD_MS;
    this.restoring = {
      element: binding.element,
      target: (settled) => binding.geometry.target(position, settled),
      holdUntil,
      until: Math.max(until, holdUntil),
      stopResize: null,
      timer: null,
    };
    this.place();
    this.frame = requestAnimationFrame(this.hold);
  }

  /** Hands the scroller to a reveal; a position the reader already scrolled to is kept. */
  stop(): void {
    this.endRestore();
    this.pending.flush();
    this.state = "idle";
  }

  /** Saves where a landed reveal put the reader, without reading the half-rendered DOM. */
  record(position: ReadingPosition): void {
    this.stop();
    this.anchor = position;
    this.pending.write(position);
  }

  dispose(): void {
    this.stop();
    this.root.removeEventListener("wheel", this.arm, { capture: true });
    this.root.removeEventListener("touchstart", this.arm, { capture: true });
    this.root.removeEventListener("pointerdown", this.press, { capture: true });
    this.root.removeEventListener("keydown", this.arm, { capture: true });
    this.root.removeEventListener("scroll", this.onScroll, { capture: true });
    window.removeEventListener("pointerup", this.release, true);
    window.removeEventListener("pointercancel", this.release, true);
    window.removeEventListener("pagehide", this.pending.flush);
  }

  private readonly press = (event: Event) => {
    this.pointerDown = true;
    this.arm(event);
  };

  private readonly release = () => {
    this.pointerDown = false;
    if (this.state === "armed" && !this.pending.waiting && this.frame === null) this.state = "idle";
  };

  private readonly arm = (event: Event) => {
    if (this.state === "holding") this.endRestore();
    this.state = "armed";
    // Input that scrolls nothing (a key in the editor, a wheel at the end) disarms after the delay.
    this.pending.touch();
    this.onInput?.(event);
  };

  private readonly onScroll = (event: Event) => {
    if (this.state !== "armed" || this.frame !== null || !(event.target instanceof HTMLElement)) {
      return;
    }
    const binding = this.bind(event.target);
    if (binding !== null) this.capture(binding, CAPTURE_ATTEMPTS);
  };

  private capture(binding: Binding, attempts: number): void {
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.state !== "armed") return;
      const position = binding.geometry.capture();
      if (position === null) {
        // Pierre moves its rendered window a frame or two after a long jump.
        if (attempts > 1) this.capture(binding, attempts - 1);
        return;
      }
      this.anchor = position;
      this.pending.hold(position);
    });
  }

  private readonly hold = (time: number) => {
    this.frame = null;
    const restoring = this.restoring;
    if (this.state !== "holding" || restoring === null) return;
    if (time < restoring.holdUntil) {
      this.place();
      this.frame = requestAnimationFrame(this.hold);
      return;
    }
    this.place();
    const remaining = restoring.until - performance.now();
    if (remaining <= 0) {
      this.endRestore();
      this.state = "idle";
      return;
    }
    const { element } = restoring;
    const content = element.firstElementChild;
    restoring.stopResize = observeResize(content === null ? element : [element, content], () =>
      this.place(),
    );
    restoring.timer = setTimeout(() => {
      this.endRestore();
      if (this.state === "holding") this.state = "idle";
    }, remaining);
  };

  private place(): void {
    const restoring = this.restoring;
    if (restoring === null) return;
    const { element } = restoring;
    const target = restoring.target(performance.now() >= restoring.holdUntil);
    if (target === null) return;
    const top = clamp(target.top, element.scrollHeight - element.clientHeight);
    if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
    if (target.left === undefined) return;
    const left = clamp(target.left, element.scrollWidth - element.clientWidth);
    if (Math.abs(element.scrollLeft - left) > 1) element.scrollLeft = left;
  }

  private endRestore(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const restoring = this.restoring;
    this.restoring = null;
    restoring?.stopResize?.();
    if (restoring?.timer != null) clearTimeout(restoring.timer);
  }
}

const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max));

/** Table or large text rows, which restore through the viewer's own reveal. */
interface RowsBinding extends Binding<SourcePosition | RenderedPosition> {
  readonly restores: "rows";
  readonly raw: boolean;
}

/** A viewer's main scroller and the view it restores from. */
type ViewerBinding =
  | (Binding<RenderedPosition> & { readonly restores: "rendered" })
  | (Binding<OffsetPosition> & { readonly restores: "offset" })
  | (Binding<SourcePosition> & { readonly restores: "source" })
  | RowsBinding;

type Shape = (root: HTMLElement, file: FileReadingKey) => ViewerBinding | null;

/**
 * Only a workbook's first visible sheet keeps a place; `data-sheet` is the sheet's position among
 * the visible ones, and a viewer that is no sheet has none.
 */
const laterSheet = (element: HTMLElement) =>
  element.dataset.sheet !== undefined && element.dataset.sheet !== "0";

/** Items in order, such as pages or cells; the viewport top's item and fraction is the place. */
function blockGeometry(
  scroller: HTMLElement,
  items: () => ArrayLike<Element> | undefined,
  /** Items mount in batches, so an index past the end waits for the hold before it caps. */
  batched: boolean,
): ViewGeometry<RenderedPosition> {
  return {
    target(position, settled) {
      // The first item's top margin belongs to the top of the file.
      if (position.block === 0 && position.fraction === 0) return { top: 0 };
      const list = items();
      if (list === undefined || list.length === 0) return null;
      const item = list[position.block];
      if (item === undefined) return batched && !settled ? null : { top: scroller.scrollHeight };
      const rect = item.getBoundingClientRect();
      return {
        top:
          scroller.scrollTop +
          rect.top -
          scroller.getBoundingClientRect().top +
          position.fraction * rect.height,
      };
    },
    capture() {
      const list = items();
      if (list === undefined || list.length === 0) return null;
      const top = scroller.getBoundingClientRect().top;
      let low = 0;
      let high = list.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (list[middle]!.getBoundingClientRect().bottom > top) high = middle;
        else low = middle + 1;
      }
      const rect = list[low]!.getBoundingClientRect();
      const fraction = rect.height > 0 ? (top - rect.top) / rect.height : 0;
      return { view: "rendered", block: low, fraction: Math.min(Math.max(0, fraction), 0.999) };
    },
  };
}

function blocks(
  scroller: HTMLElement | null | undefined,
  items: (scroller: HTMLElement) => ArrayLike<Element> | undefined,
  batched: boolean,
): ViewerBinding | null {
  if (!scroller) return null;
  return {
    element: scroller,
    restores: "rendered",
    geometry: blockGeometry(scroller, () => items(scroller), batched),
  };
}

function offsetBinding(scroller: Element | null | undefined): ViewerBinding | null {
  if (!(scroller instanceof HTMLElement) || laterSheet(scroller)) return null;
  return {
    element: scroller,
    restores: "offset",
    geometry: {
      target: (position) => ({ top: position.top, left: position.left }),
      capture: () => ({
        view: "offset",
        top: Math.max(0, scroller.scrollTop),
        left: Math.max(0, scroller.scrollLeft),
      }),
    },
  };
}

/** Table rows keep their index and a raw text row its line; the viewer restores them itself. */
function rowsGeometry(
  scroller: HTMLElement,
  raw: boolean,
): ViewGeometry<SourcePosition | RenderedPosition> {
  return {
    target: () => null,
    capture() {
      const top = scroller.getBoundingClientRect().top;
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-preview-row]")) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        const index = Number(row.dataset.previewRow);
        if (raw) return { view: "source", line: index + 1, offset: 0 };
        const fraction = rect.height > 0 ? (top - rect.top) / rect.height : 0;
        return { view: "rendered", block: index, fraction: Math.min(Math.max(0, fraction), 0.999) };
      }
      return null;
    },
  };
}

/** VirtualTablePreview: a table, or a raw text region, whose rows scroll in its focusable child. */
export const ROWS_SELECTOR = '[aria-rowcount]:is([role="table"], [role="region"])';
const GRID_SELECTOR = '[role="grid"][aria-rowcount]';
const VIEWER_MOUNTED = "t3code-viewer-mounted";

/**
 * A viewer that mounts deep in the container, such as a sheet's rows or an Excel grid, asks for
 * its place; a direct-child swap or an input look may not see it.
 */
export function announceViewer(viewer: HTMLElement | null): void {
  viewer?.dispatchEvent(new Event(VIEWER_MOUNTED, { bubbles: true }));
}

const announcedBinding = (viewer: HTMLElement): ViewerBinding | null =>
  viewer.matches(ROWS_SELECTOR)
    ? rowsOf(viewer)
    : viewer.matches(GRID_SELECTOR)
      ? offsetBinding(viewer)
      : null;

function rowsOf(rows: HTMLElement | null): RowsBinding | null {
  const element = rows?.querySelector<HTMLElement>(":scope > [tabindex]");
  if (!rows || !element || laterSheet(rows)) return null;
  const raw = rows.getAttribute("role") === "region";
  return { element, restores: "rows", raw, geometry: rowsGeometry(element, raw) };
}

/** Viewer families by their markup, tried in order; the first that shows owns the container. */
const SHAPES: ReadonlyArray<Shape> = [
  (root) => rowsOf(root.querySelector<HTMLElement>(ROWS_SELECTOR)),
  (root) =>
    blocks(
      root.querySelector<HTMLElement>("[data-office-pages]"),
      (scroller) => scroller.querySelectorAll(':scope > div > div > [role="group"]'),
      true,
    ),
  // NotebookPreview: its cells sit two levels below its scroller.
  (root) =>
    blocks(
      root.querySelector("section[aria-label]:not(.chat-markdown section)")?.parentElement
        ?.parentElement,
      (scroller) => scroller.querySelectorAll(":scope > div > section[aria-label]"),
      false,
    ),
  (root) =>
    blocks(
      root
        .querySelector(".chat-markdown")
        ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]'),
      (scroller) => scroller.querySelector(".chat-markdown")?.children,
      false,
    ),
  // An Excel sheet's grid.
  (root) => offsetBinding(root.querySelector(GRID_SELECTOR)),
  (root) => offsetBinding(root.querySelector("[data-markdown-mermaid]")?.parentElement),
  // An attachment's source view, whose lines only Pierre knows: the pixels below line 1. A
  // workspace file's source view has its own tracker.
  (root, file) => {
    const element =
      file.kind === "attachment"
        ? root.querySelector<HTMLElement>(".file-preview-virtualizer")
        : null;
    if (!element) return null;
    return {
      element,
      restores: "source",
      geometry: {
        target: (position) => (position.line === 1 ? { top: position.offset } : null),
        capture: () => ({ view: "source", line: 1, offset: Math.max(0, element.scrollTop) }),
      },
    };
  },
];

const findBinding: Shape = (root, file) => {
  for (const shape of SHAPES) {
    const binding = shape(root, file);
    if (binding !== null) return binding;
  }
  return null;
};

/** A workspace file's code view or editor, which keeps its own place (`trackSourceView`). */
const ownPlace = (root: HTMLElement, file: FileReadingKey) =>
  file.kind === "path" ? root.querySelector(".file-preview-virtualizer") : null;

/**
 * Saves the playback time of video and audio under `root` once the reader used the element's
 * controls, and restores it paused when the element loads, so a first-frame seek is never saved.
 */
function keepMediaTime(root: HTMLElement, file: FileReadingKey): () => void {
  const pending = new PendingPosition(file);
  let used: HTMLMediaElement | null = null;
  let heldTime = -1;
  // A video embedded in rendered Markdown is not the file's own playback.
  const mediaOf = (event: Event) =>
    event.target instanceof HTMLMediaElement && event.target.closest(".chat-markdown") === null
      ? event.target
      : null;
  const hold = (media: HTMLMediaElement) => {
    if (!Number.isFinite(media.currentTime)) return;
    heldTime = media.currentTime;
    pending.hold({ view: "media", time: Math.max(0, media.currentTime) });
  };
  // A source still loading, such as a changed file, reports zero until `restore` returns it to
  // the reader's place, so it has no time to save.
  const moved = (media: HTMLMediaElement) =>
    media.readyState < HTMLMediaElement.HAVE_METADATA ? 0 : Math.abs(media.currentTime - heldTime);
  const use = (event: Event) => {
    used = mediaOf(event) ?? used;
  };
  const save = (event: Event) => {
    const media = mediaOf(event);
    if (media === null || media !== used) return;
    if (moved(media) < (event.type === "timeupdate" ? 1 : SAME_TIME_S)) return;
    hold(media);
  };
  const restore = (event: Event) => {
    const media = mediaOf(event);
    if (media === null || media.played.length > 0) return;
    const saved = readings.readPosition(file, "media");
    if (saved !== null && saved.time > 0) {
      media.currentTime = Number.isFinite(media.duration)
        ? Math.min(saved.time, media.duration)
        : saved.time;
    }
    // Added in the capture phase, this runs after the player's own handler, which may seek to
    // the first frame; the source starts there, so `exit` saves it only once playback moves.
    media.addEventListener(
      "loadedmetadata",
      () => {
        heldTime = media.currentTime;
      },
      { once: true },
    );
  };
  // The player may pause an element it already removed, so its last events miss the container.
  // Unmoved playback keeps its capture time, so a newer sample from another tab still wins.
  const exit = () => {
    if (used !== null && moved(used) >= SAME_TIME_S) hold(used);
    pending.flush();
  };
  // Media events do not bubble, but their capture phase reaches every ancestor.
  const listeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ["pointerdown", use],
    ["keydown", use],
    ["pause", save],
    ["seeked", save],
    ["timeupdate", save],
    ["loadedmetadata", restore],
  ];
  for (const [type, listener] of listeners) root.addEventListener(type, listener, true);
  window.addEventListener("pagehide", exit);
  return () => {
    for (const [type, listener] of listeners) root.removeEventListener(type, listener, true);
    window.removeEventListener("pagehide", exit);
    exit();
  };
}

/** A pending citation's line in the file, and the reveal ledger's word on it. */
export interface Citation {
  /** Unique to the tab request that cited the line. */
  readonly id: number;
  readonly line: number;
  readonly pending: () => boolean;
  readonly shown: () => void;
}

/** The line a large text viewer (`source`) or a table (`table`) reveals when it is ready. */
interface RowLines {
  readonly source: number | null;
  readonly table: number | null;
}

const NO_LINES: RowLines = { source: null, table: null };
const REVEALED_ROW = '[data-preview-reveal="true"]';

/**
 * One file shown in the container, from when it opens until another file or a new citation
 * replaces it. The panel reads its row lines as a store; the rest belongs to its event handlers.
 */
class Visit {
  private lines: RowLines;
  private readonly listeners = new Set<() => void>();
  /** The rows scroller of the viewer mount the lines belong to. */
  private rows: HTMLElement | null = null;
  private dropped = false;
  private stopReveal: (() => void) | null = null;

  constructor(
    readonly fileId: string,
    private readonly file: FileReadingKey | undefined,
    private readonly views: ReadonlyArray<ReadingView>,
    private readonly citation: Citation | null,
  ) {
    this.lines = this.restoreLines();
  }

  get citationId(): number | null {
    return this.citation?.id ?? null;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = () => this.lines;

  readonly attach = (root: HTMLElement | null) => {
    const file = this.file;
    if (root === null || file === undefined || this.views.length === 0) return;
    const handled = new WeakSet<Element>();
    const bound = new WeakMap<Element, ViewerBinding | null>();
    /** The scroller placed or scrolled last; changes inside it bring no new viewer. */
    let latest: Element | null = null;
    const take = (element: Element) => {
      handled.add(element);
      latest = element;
    };
    const bind = (element: HTMLElement) => {
      let binding = bound.get(element);
      if (binding === undefined) {
        const found = findBinding(root, file);
        binding = found?.element === element ? found : null;
        bound.set(element, binding);
        // The reader scrolled it, so a later look must not move it.
        if (binding !== null) take(element);
      }
      if (binding?.restores === "rows") this.drop(file, binding);
      return binding;
    };
    const tracker = new ReadingTracker(root, file, bind, (event) => {
      if (
        (event.type === "pointerdown" || event.type === "keydown") &&
        event.target instanceof Element &&
        event.target.closest(VIEWER_SWITCH) !== null
      ) {
        startLook(INPUT_LOOK_MS);
      }
    });
    let observer: MutationObserver | null = null;
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let until = 0;
    const restore = <P extends ReadingPosition>(binding: Binding<P>, saved: P | null) => {
      if (saved !== null) tracker.restore(binding, saved, until);
    };
    const stopLook = () => {
      observer?.disconnect();
      observer = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    /** Places a viewer seen for the first time; the look has found what it watched for. */
    const settle = (element: Element, binding: ViewerBinding | null) => {
      take(element);
      stopLook();
      if (binding === null) return;
      if (binding.restores === "rows") this.mountRows(file, binding);
      else if (binding.restores === "rendered") {
        restore(binding, readings.readPosition(file, "rendered"));
      } else if (binding.restores === "offset") {
        // A grid a cell link opened shows that cell; the reader's later scrolls still save.
        if (binding.element.dataset.linkedCell === undefined) {
          restore(binding, readings.readPosition(file, "offset"));
        }
      } else restore(binding, readings.readPosition(file, "source"));
    };
    const check = () => {
      frame = null;
      if (!this.awaitsViewer(file)) return stopLook();
      const binding = findBinding(root, file);
      const element = binding?.element ?? ownPlace(root, file);
      if (element && !handled.has(element)) settle(element, binding);
    };
    /** Watches the viewer for a scroller it has not placed yet, then places it once. */
    const startLook = (ms: number) => {
      if (observer === null && !this.awaitsViewer(file)) return;
      const end = performance.now() + ms;
      if (end <= until && observer !== null) return;
      until = end;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(stopLook, ms);
      if (observer !== null) return;
      observer = new MutationObserver((records) => {
        if (records.every((record) => latest?.contains(record.target) === true)) return;
        frame ??= requestAnimationFrame(check);
      });
      observer.observe(root, { childList: true, subtree: true });
      check();
    };
    // A new viewer, such as rendered and source Markdown or a changed file, replaces the children.
    const swaps = new MutationObserver(() => startLook(LOOK_MS));
    swaps.observe(root, { childList: true });
    startLook(LOOK_MS);
    const onMounted = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (!this.awaitsViewer(file) && !this.hasRowPlace()) return;
      const binding = announcedBinding(event.target);
      if (binding !== null && !handled.has(binding.element)) settle(binding.element, binding);
    };
    root.addEventListener(VIEWER_MOUNTED, onMounted);
    const stopMedia = keepMediaTime(root, file);
    return () => {
      swaps.disconnect();
      root.removeEventListener(VIEWER_MOUNTED, onMounted);
      stopLook();
      this.stopReveal?.();
      this.rows = null;
      tracker.dispose();
      stopMedia();
    };
  };

  private citedLine(): number | null {
    const citation = this.citation;
    return citation?.pending() === true ? citation.line : null;
  }

  /** A citation not yet shown, or a saved place in a view this container restores. */
  private awaitsViewer(file: FileReadingKey): boolean {
    return (
      this.citedLine() !== null ||
      this.views.some((view) => readings.readPosition(file, view) !== null)
    );
  }

  private restoreLines(): RowLines {
    const file = this.file;
    if (file === undefined) return NO_LINES;
    const rendered = readings.readPosition(file, "rendered");
    return {
      source: this.citedLine() ?? readings.readPosition(file, "source")?.line ?? null,
      table: rendered === null ? null : rendered.block + 1,
    };
  }

  private hasRowPlace(): boolean {
    const lines = this.restoreLines();
    return lines.source !== null || lines.table !== null;
  }

  private publish(lines: RowLines): void {
    if (lines.source === this.lines.source && lines.table === this.lines.table) return;
    this.lines = lines;
    for (const listener of this.listeners) listener();
  }

  /** A rows viewer mounted: it reveals a citation not yet shown, else the newest place. */
  private mountRows(file: FileReadingKey, rows: RowsBinding): void {
    if (rows.element === this.rows) return;
    this.stopReveal?.();
    this.rows = rows.element;
    this.dropped = false;
    this.publish(this.restoreLines());
    if (rows.raw && this.citedLine() !== null) this.awaitReveal(file, rows.element);
  }

  /**
   * The reader scrolled the rows, so finished indexing must not move them. Raw rows still reveal
   * a pending citation; a table never shows one.
   */
  private drop(file: FileReadingKey, rows: RowsBinding): void {
    this.mountRows(file, rows);
    if (this.dropped || (rows.raw && this.citedLine() !== null)) return;
    this.dropped = true;
    this.publish(NO_LINES);
  }

  /** Once the rows show the cited line, it becomes the file's place and the citation is shown. */
  private awaitReveal(file: FileReadingKey, rows: HTMLElement): void {
    const citation = this.citation;
    if (citation === null) return;
    const observer = new MutationObserver(() => check());
    const stop = () => {
      observer.disconnect();
      if (this.stopReveal === stop) this.stopReveal = null;
    };
    const check = () => {
      if (!citation.pending()) return stop();
      if (rows.querySelector(REVEALED_ROW) === null) return;
      stop();
      readings.writePosition(file, { view: "source", line: citation.line, offset: 0 });
      citation.shown();
    };
    this.stopReveal = stop;
    observer.observe(rows, {
      childList: true,
      subtree: true,
      attributeFilter: ["data-preview-reveal"],
    });
    check();
  }
}

export interface ViewerPlace {
  /** The ref for the element that holds the file's viewer. */
  readonly ref: (root: HTMLElement | null) => (() => void) | undefined;
  /**
   * The line a table (`table`) or raw large text viewer reveals: a pending citation's line, or
   * the reader's row; null once the reader scrolls the mounted rows.
   */
  readonly rowLine: (table: boolean) => number | null;
}

/** Keeps the place of whatever viewer the container holds for `file`. */
export function useViewerPlace(input: {
  readonly file: FileReadingKey | undefined;
  /** The saved views the container restores; none when a frame or PDF.js keeps the place. */
  readonly views: ReadonlyArray<ReadingView>;
  /** A citation still pending when it opens the file; a new one starts a new visit. */
  readonly citation: Citation | null;
}): ViewerPlace {
  const fileId = input.file === undefined ? "" : fileReadingId(input.file);
  const create = () => new Visit(fileId, input.file, input.views, input.citation);
  const [stored, setStored] = useState(create);
  let visit = stored;
  if (
    stored.fileId !== fileId ||
    (input.citation !== null && input.citation.id !== stored.citationId)
  ) {
    visit = create();
    setStored(visit);
  }
  const lines = useSyncExternalStore(visit.subscribe, visit.snapshot);
  return { ref: visit.attach, rowLine: (table) => (table ? lines.table : lines.source) };
}

import { VirtualizedFile, type File as FileInstance, type PostRenderPhase } from "@pierre/diffs";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { useState } from "react";

import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  createRevealLedger,
  liveFileSurface,
  type FileReadingKey,
  type ReadingPosition,
  type ReadingPositionOf,
  type RevealVerdict,
} from "./fileReadingStore";

import { PendingPosition, readings } from "./fileReadingSave";

const HOLD_MS = 1000;
const CAPTURE_ATTEMPTS = 8;

const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);
ledger.start();

type FilePostRender = <LAnnotation>(
  fileContainer: HTMLElement,
  instance: FileInstance<LAnnotation, undefined>,
  phase: PostRenderPhase,
) => void;
type SourcePosition = ReadingPositionOf<"source">;
type RenderedPosition = ReadingPositionOf<"rendered">;

interface ViewGeometry<P extends ReadingPosition> {
  /** The scroll top that puts `position` at the viewport top, or null until the content can place it. */
  target(position: P): number | null;
  /** The position at the viewport top, or null while the content cannot tell. */
  capture(): P | null;
}

/**
 * Restores and saves one scroll container's position. Only scrolls that follow reader input on the
 * container are saved, so restores, reveals and layout resets never overwrite a saved position.
 */
class ReadingTracker<P extends ReadingPosition> {
  private state: "idle" | "holding" | "armed" = "idle";
  private frame: number | null = null;
  private holdUntil = 0;
  /** A scrollbar drag can pause longer than the save delay without a new pointerdown. */
  private pointerDown = false;
  private readonly pending: PendingPosition;
  /** The restored or last captured position. */
  anchor: P | null = null;

  /** `input` receives reader input; it differs from `element` when a custom scrollbar sits beside it. */
  constructor(
    private readonly element: HTMLElement,
    file: FileReadingKey,
    private readonly geometry: ViewGeometry<P>,
    private readonly input: HTMLElement = element,
  ) {
    this.pending = new PendingPosition(file, () => {
      if (this.state === "armed" && !this.pointerDown) this.state = "idle";
    });
    input.addEventListener("wheel", this.arm, { passive: true });
    input.addEventListener("touchstart", this.arm, { passive: true });
    input.addEventListener("pointerdown", this.press, { passive: true, capture: true });
    input.addEventListener("keydown", this.arm, { capture: true });
    element.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("pointerup", this.release, true);
    window.addEventListener("pointercancel", this.release, true);
    window.addEventListener("pagehide", this.pending.flush);
  }

  restore(position: P): void {
    this.cancelFrame();
    this.anchor = position;
    this.state = "holding";
    this.holdUntil = performance.now() + HOLD_MS;
    this.place(position);
    this.frame = requestAnimationFrame(this.hold);
  }

  /** Hands the container to a reveal; a position the reader already scrolled to is kept. */
  stop(): void {
    this.cancelFrame();
    this.pending.flush();
    this.state = "idle";
  }

  /** Saves where a landed reveal put the reader, without reading the half-rendered DOM. */
  record(position: P): void {
    this.stop();
    this.anchor = position;
    this.pending.write(position);
  }

  dispose(): void {
    this.stop();
    this.input.removeEventListener("wheel", this.arm);
    this.input.removeEventListener("touchstart", this.arm);
    this.input.removeEventListener("pointerdown", this.press, { capture: true });
    this.input.removeEventListener("keydown", this.arm, { capture: true });
    this.element.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("pointerup", this.release, true);
    window.removeEventListener("pointercancel", this.release, true);
    window.removeEventListener("pagehide", this.pending.flush);
  }

  private readonly press = () => {
    this.pointerDown = true;
    this.arm();
  };

  private readonly release = () => {
    this.pointerDown = false;
    if (this.state === "armed" && !this.pending.waiting && this.frame === null) this.state = "idle";
  };

  private readonly arm = () => {
    if (this.state === "holding") this.cancelFrame();
    this.state = "armed";
    // Input that scrolls nothing (a key in the editor, a wheel at the end) disarms after the delay.
    this.pending.touch();
  };

  private readonly onScroll = () => {
    if (this.state === "armed" && this.frame === null) this.capture(CAPTURE_ATTEMPTS);
  };

  private capture(attempts: number): void {
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.state !== "armed") return;
      const position = this.geometry.capture();
      if (position === null) {
        // Pierre moves its rendered window a frame or two after a long jump.
        if (attempts > 1) this.capture(attempts - 1);
        return;
      }
      this.anchor = position;
      this.pending.hold(position);
    });
  }

  private readonly hold = (time: number) => {
    this.frame = null;
    if (this.state !== "holding" || this.anchor === null) return;
    if (time >= this.holdUntil) {
      this.state = "idle";
      return;
    }
    this.place(this.anchor);
    this.frame = requestAnimationFrame(this.hold);
  };

  private place(position: P): void {
    const target = this.geometry.target(position);
    if (target === null) return;
    const max = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
    const top = Math.min(Math.max(0, target), max);
    if (Math.abs(this.element.scrollTop - top) > 1) this.element.scrollTop = top;
  }

  private cancelFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

type SourceLines = Pick<
  VirtualizedFile<unknown, undefined>,
  "getLinePosition" | "getNumericScrollAnchor"
>;

class SourceGeometry implements ViewGeometry<SourcePosition> {
  constructor(
    private readonly element: HTMLElement,
    private fileContainer: HTMLElement,
    private lines: SourceLines,
  ) {}

  follow(fileContainer: HTMLElement, lines: SourceLines): void {
    this.fileContainer = fileContainer;
    this.lines = lines;
  }

  target(position: SourcePosition): number | null {
    const line = this.lines.getLinePosition(position.line);
    return line === undefined ? null : this.fileTop() + line.top + position.offset;
  }

  capture(): SourcePosition | null {
    const viewportTop = this.element.scrollTop - this.fileTop();
    const anchor = this.lines.getNumericScrollAnchor(viewportTop);
    if (anchor === undefined) return null;
    return { view: "source", line: anchor.lineNumber, offset: viewportTop - anchor.top };
  }

  /** Where a line reveal centers `line`. */
  centered(line: number): SourcePosition {
    const height = this.lines.getLinePosition(line)?.height ?? 0;
    return { view: "source", line, offset: -Math.max(0, (this.element.clientHeight - height) / 2) };
  }

  private fileTop(): number {
    return (
      this.element.scrollTop +
      this.fileContainer.getBoundingClientRect().top -
      this.element.getBoundingClientRect().top
    );
  }
}

class RenderedGeometry implements ViewGeometry<RenderedPosition> {
  constructor(private readonly viewport: HTMLElement) {}

  target(position: RenderedPosition): number | null {
    // The first block's top margin belongs to the top of the file.
    if (position.block === 0 && position.fraction === 0) return 0;
    const blocks = this.blocks();
    if (!blocks || blocks.length === 0) return null;
    // A block past the end of shorter contents clamps to the bottom.
    const block = blocks.item(position.block);
    if (!block) return this.viewport.scrollHeight;
    const rect = block.getBoundingClientRect();
    return (
      this.viewport.scrollTop +
      rect.top -
      this.viewport.getBoundingClientRect().top +
      position.fraction * rect.height
    );
  }

  capture(): RenderedPosition | null {
    const blocks = this.blocks();
    if (!blocks || blocks.length === 0) return null;
    const top = this.viewport.getBoundingClientRect().top;
    let low = 0;
    let high = blocks.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (blocks[middle]!.getBoundingClientRect().bottom > top) high = middle;
      else low = middle + 1;
    }
    const rect = blocks[low]!.getBoundingClientRect();
    const fraction = rect.height > 0 ? (top - rect.top) / rect.height : 0;
    return { view: "rendered", block: low, fraction: Math.min(Math.max(0, fraction), 0.999) };
  }

  private blocks(): HTMLCollection | undefined {
    return this.viewport.querySelector(".chat-markdown")?.children;
  }
}

interface SourceBinding {
  readonly tracker: ReadingTracker<SourcePosition>;
  readonly geometry: SourceGeometry;
}
// Keyed by Pierre's file container: its unmount phase also fires when the file turns into a placeholder.
const sourceBindings = new WeakMap<HTMLElement, SourceBinding>();
const sourceTrackerByFile = new Map<string, ReadingTracker<SourcePosition>>();
const fileId = (file: FileReadingKey) => JSON.stringify([file.environmentId, file.absolutePath]);

function trackSourceView(
  fileContainer: HTMLElement,
  instance: SourceLines,
  phase: PostRenderPhase,
  file: FileReadingKey,
  verdict: RevealVerdict,
): void {
  const existing = sourceBindings.get(fileContainer);
  if (phase === "unmount") {
    existing?.tracker.dispose();
    sourceBindings.delete(fileContainer);
    if (existing !== undefined && sourceTrackerByFile.get(fileId(file)) === existing.tracker) {
      sourceTrackerByFile.delete(fileId(file));
    }
    return;
  }
  if (existing !== undefined) {
    existing.geometry.follow(fileContainer, instance);
    if (verdict === "pending") existing.tracker.stop();
    return;
  }
  const element = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
  if (element === null) return;
  const geometry = new SourceGeometry(element, fileContainer, instance);
  const tracker = new ReadingTracker(element, file, geometry);
  sourceBindings.set(fileContainer, { tracker, geometry });
  sourceTrackerByFile.set(fileId(file), tracker);
  if (verdict === "pending") return;
  const saved = readings.readPosition(file, "source");
  if (saved !== null) tracker.restore(saved);
}

/**
 * Where the file panel's current file was last read. A line reveal the tab has not shown yet
 * wins over the saved position; once shown, the saved position wins.
 */
export function useFileReadingPosition(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** The tab's own path, as the right panel store names it. */
  readonly requestedPath: string | null;
  readonly cwd: string;
  /** The workspace file shown, or null for an attachment. */
  readonly relativePath: string | null;
  readonly revealLine: number | null;
}) {
  const threadKey = scopedThreadKey(input.threadRef);
  const surface = useRightPanelStore((state) =>
    liveFileSurface(state.byThreadKey[threadKey], input.requestedPath),
  );
  const verdict = ledger.verdict(surface);
  const file =
    input.relativePath === null
      ? null
      : {
          environmentId: input.environmentId,
          absolutePath: resolvePathLinkTarget(input.relativePath, input.cwd),
        };
  const viewMount = () => ({
    surface,
    renderedAllowed:
      verdict === "shown" &&
      file !== null &&
      readings.newestView(file, ["source", "rendered"]) === "rendered",
  });
  // A reveal that lands while this file's view is mounted must not flip it to rendered.
  const [mounted, setMounted] = useState(viewMount);
  if (mounted.surface !== surface) setMounted(viewMount());

  return {
    scrollLine: verdict === "pending" ? input.revealLine : null,
    revealKey: ledger.generation(surface),
    renderedAllowed: mounted.renderedAllowed,
    /** Asked just before a reveal scrolls: a reopened tab whose citation was shown restores instead. */
    keepReveal: (fileContainer: HTMLElement) => {
      if (file === null || ledger.verdict(surface) !== "shown") return true;
      const saved = readings.readPosition(file, "source");
      const binding = sourceBindings.get(fileContainer);
      if (saved === null || binding === undefined) return true;
      binding.tracker.restore(saved);
      return false;
    },
    onRevealApplied: (fileContainer: HTMLElement, line: number) => {
      if (surface !== undefined) ledger.markShown(threadKey, surface);
      const binding = sourceBindings.get(fileContainer);
      binding?.tracker.record(binding.geometry.centered(line));
    },
    trackSource:
      (reveal: FilePostRender): FilePostRender =>
      (fileContainer, instance, phase) => {
        reveal(fileContainer, instance, phase);
        if (file === null || !(instance instanceof VirtualizedFile)) return;
        // A landed reveal does not re-render the panel, so ask the ledger now.
        trackSourceView(fileContainer, instance, phase, file, ledger.verdict(surface));
      },
    caretLine: (): number | "first-visible" =>
      (ledger.verdict(surface) === "pending" ? input.revealLine : null) ??
      (file === null ? undefined : sourceTrackerByFile.get(fileId(file))?.anchor?.line) ??
      "first-visible",
  };
}

/** A stable ref for a rendered Markdown `ScrollArea` root, restoring and saving its top block. */
export function useRenderedReadingPosition(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  const [ref] = useState(() => (root: HTMLElement | null) => {
    const viewport = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const file = { environmentId, absolutePath: resolvePathLinkTarget(relativePath, cwd) };
    const tracker = new ReadingTracker(
      viewport,
      file,
      new RenderedGeometry(viewport),
      root ?? viewport,
    );
    const saved = readings.readPosition(file, "rendered");
    if (saved !== null) tracker.restore(saved);
    return () => tracker.dispose();
  });
  return ref;
}

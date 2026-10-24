import type { PostRenderPhase } from "@pierre/diffs";
import { useEffect, useState } from "react";

// Source offsets in selection order: the anchor stays put while the focus
// follows the pointer or keyboard, as in the DOM Selection API.
interface SourceSelection {
  readonly anchor: number;
  readonly focus: number;
}

interface DomPoint {
  readonly node: Node;
  readonly offset: number;
}

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

// Matches how Pierre splits rows: `\r\n`, `\r`, and `\n` each end a line,
// and a rendered row holds the line without its terminator.
function getLineStarts(state: SourceTextSelection): number[] {
  if (state.lineStarts) return state.lineStarts;
  const { text } = state;
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    if (char !== LINE_FEED && char !== CARRIAGE_RETURN) continue;
    if (char === CARRIAGE_RETURN && text.charCodeAt(index + 1) === LINE_FEED) index++;
    starts.push(index + 1);
  }
  state.lineStarts = starts;
  return starts;
}

function lineBounds(
  state: SourceTextSelection,
  lineNumber: number,
): { start: number; end: number } | null {
  const starts = getLineStarts(state);
  const start = starts[lineNumber - 1];
  if (start === undefined) return null;
  const next = starts[lineNumber];
  if (next === undefined) return { start, end: state.text.length };
  const crlf = next - start >= 2 && state.text.charCodeAt(next - 2) === CARRIAGE_RETURN;
  return { start, end: next - (crlf && state.text.charCodeAt(next - 1) === LINE_FEED ? 2 : 1) };
}

function lineAtOffset(state: SourceTextSelection, offset: number): number {
  const starts = getLineStarts(state);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function renderedLine(element: Element): number | null {
  const lineNumber = Number((element as HTMLElement).dataset.line);
  return Number.isInteger(lineNumber) ? lineNumber : null;
}

// `inRow` maps only points inside a rendered row. A point the browser moved
// to a container because its row was virtualized away carries no position.
function domPointToOffset(
  state: SourceTextSelection,
  point: DomPoint,
  inRow: boolean,
): number | null {
  const { node, offset } = point;
  const element = node instanceof Element ? node : node.parentElement;
  const lineElement = element?.closest("[data-line]");
  if (!lineElement) {
    // Drags past the first or last row end on the code column itself.
    if (inRow || !(node instanceof Element)) return null;
    const after = node.childNodes[offset];
    const lineAfter =
      after instanceof Element
        ? after.matches("[data-line]")
          ? after
          : after.querySelector("[data-line]")
        : null;
    if (lineAfter) {
      const lineNumber = renderedLine(lineAfter);
      return lineNumber === null ? null : (lineBounds(state, lineNumber)?.start ?? null);
    }
    const lines = node.querySelectorAll("[data-line]");
    const last = lines[lines.length - 1];
    const lineNumber = last ? renderedLine(last) : null;
    return lineNumber === null ? null : (lineBounds(state, lineNumber)?.end ?? null);
  }
  const lineNumber = renderedLine(lineElement);
  const bounds = lineNumber === null ? null : lineBounds(state, lineNumber);
  if (!bounds) return null;
  const prefix = document.createRange();
  prefix.setStart(lineElement, 0);
  prefix.setEnd(node, offset);
  // Empty rows render a "\n" placeholder, so clamp to the line's own length.
  return Math.min(bounds.start + prefix.toString().length, bounds.end);
}

function offsetToDomPoint(lineElement: Element, column: number): DomPoint {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
  let remaining = column;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.length) return { node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : { node: lineElement, offset: 0 };
}

type ComposedRanges = (...args: unknown[]) => StaticRange[];

function readComposedRange(selection: Selection, root: ShadowRoot): AbstractRange | null {
  const getComposedRanges = selection.getComposedRanges as unknown as ComposedRanges;
  try {
    return getComposedRanges.call(selection, { shadowRoots: [root] })[0] ?? null;
  } catch {
    // Safari 17 takes the shadow roots as separate arguments.
    return getComposedRanges.call(selection, root)[0] ?? null;
  }
}

// The DOM selection's anchor and focus, with nodes inside `root` when the
// selection is in this preview.
function readDomSelection(root: ShadowRoot): { anchor: DomPoint; focus: DomPoint } | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  let range: AbstractRange | null = null;
  if (typeof selection.getComposedRanges === "function" && "direction" in selection) {
    range = readComposedRange(selection, root);
    if (!range) return null;
  } else {
    // Older Chromium exposes the shadow tree's selection, already directed.
    const shadowSelection = (
      root as ShadowRoot & { getSelection?: () => Selection | null }
    ).getSelection?.();
    if (shadowSelection?.anchorNode && shadowSelection.focusNode) {
      return {
        anchor: { node: shadowSelection.anchorNode, offset: shadowSelection.anchorOffset },
        focus: { node: shadowSelection.focusNode, offset: shadowSelection.focusOffset },
      };
    }
    range = selection.getRangeAt(0);
  }
  const start = { node: range.startContainer, offset: range.startOffset };
  const end = { node: range.endContainer, offset: range.endOffset };
  return selection.direction === "backward"
    ? { anchor: end, focus: start }
    : { anchor: start, focus: end };
}

// Keys that move a caret-browsing selection, and collapse it without Shift.
const CARET_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

class SourceTextSelection {
  lineStarts: number[] | null = null;
  host: HTMLElement | null = null;
  selection: SourceSelection | null = null;
  // The range last drawn by redraw, so its selectionchange is not read back
  // as a user selection clamped to the rendered rows.
  drawn: SourceSelection | null = null;
  // A pointer gesture that started in this preview is selecting. The browser
  // owns the drawn selection until it ends.
  dragging = false;
  // The last pointer or focus interaction was in this preview, so its
  // select all and an offscreen selection's copy belong here.
  engaged = false;
  // A caret key was pressed here, so a collapse inside a rendered row is the
  // user cancelling the selection rather than its rows being virtualized away.
  caretKey = false;

  constructor(public text: string) {}

  setText(text: string) {
    if (this.text === text) return;
    this.text = text;
    this.lineStarts = null;
    this.selection = null;
    this.drawn = null;
  }

  scroller(): Element | null {
    return this.host?.closest(".file-preview-virtualizer") ?? null;
  }

  // "outside" means the DOM selection is somewhere other than this preview.
  read(): { anchor: DomPoint; focus: DomPoint } | "outside" | null {
    const root = this.host?.shadowRoot;
    if (!root) return null;
    const points = readDomSelection(root);
    if (!points) return null;
    if (!root.contains(points.anchor.node) || !root.contains(points.focus.node)) return "outside";
    return points;
  }

  // Takes the text this render drew: the parent's effects run after the
  // child's postRender, too late to redraw new rows from the new text.
  onPostRender = (fileContainer: HTMLElement, phase: PostRenderPhase, text: string) => {
    if (phase === "unmount") {
      if (this.host === fileContainer) this.host = null;
      return;
    }
    this.setText(text);
    this.host = fileContainer;
    if (!this.dragging) this.redraw();
  };

  // Draws the part of the source selection that falls in the rendered rows.
  redraw() {
    const root = this.host?.shadowRoot;
    const source = this.selection;
    const selection = document.getSelection();
    if (!root || !source || !selection) return;
    const lines = root.querySelectorAll("[data-line]");
    const first = lines[0];
    const last = lines[lines.length - 1];
    const firstLine = first ? renderedLine(first) : null;
    const lastLine = last ? renderedLine(last) : null;
    const firstBounds = firstLine === null ? null : lineBounds(this, firstLine);
    const lastBounds = lastLine === null ? null : lineBounds(this, lastLine);
    if (!firstBounds || !lastBounds) return;
    const clamp = (offset: number) => Math.min(Math.max(offset, firstBounds.start), lastBounds.end);
    const target = { anchor: clamp(source.anchor), focus: clamp(source.focus) };
    const current = this.read();
    if (target.anchor === target.focus) {
      this.drawn = null;
      if (current && current !== "outside") selection.removeAllRanges();
      return;
    }
    if (current && current !== "outside") {
      const anchor = domPointToOffset(this, current.anchor, true);
      const focus = domPointToOffset(this, current.focus, true);
      if (anchor === target.anchor && focus === target.focus) {
        this.drawn = target;
        return;
      }
    }
    const point = (offset: number) => {
      const line = lineAtOffset(this, offset);
      const element = root.querySelector(`[data-line="${line}"]`);
      const start = getLineStarts(this)[line - 1];
      return element && start !== undefined ? offsetToDomPoint(element, offset - start) : null;
    };
    const anchor = point(target.anchor);
    const focus = point(target.focus);
    if (!anchor || !focus) return;
    this.drawn = target;
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  onSelectionChange = () => {
    const current = this.read();
    if (current === null) return;
    if (current === "outside") {
      // A drag that began here keeps its selection even if the browser
      // moves the range out while rows are replaced.
      if (!this.dragging) this.selection = null;
      return;
    }
    if (this.dragging) {
      // The anchor stays where the gesture began. The browser's anchor drifts
      // once its row is virtualized away, so only the first read counts.
      const anchor = this.selection?.anchor ?? domPointToOffset(this, current.anchor, true);
      const focus = domPointToOffset(this, current.focus, false);
      if (anchor === null || focus === null) return;
      this.selection = { anchor, focus };
      this.drawn = null;
      return;
    }
    const seen = {
      anchor: domPointToOffset(this, current.anchor, false),
      focus: domPointToOffset(this, current.focus, false),
    };
    if (seen.anchor === null || seen.focus === null) return;
    if (seen.anchor === seen.focus) {
      // A collapsed selection is usually a range virtualized away, which
      // leaves its points outside the rows. Clicks are handled on pointerdown.
      if (this.caretKey && domPointToOffset(this, current.focus, true) !== null) {
        this.caretKey = false;
        this.selection = null;
        this.drawn = null;
      }
      return;
    }
    // An endpoint still where redraw clamped it stands for the source one,
    // so extending a selection keeps its offscreen anchor.
    const { drawn, selection } = this;
    const anchor =
      drawn && selection && seen.anchor === drawn.anchor ? selection.anchor : seen.anchor;
    const focus = drawn && selection && seen.focus === drawn.focus ? selection.focus : seen.focus;
    this.drawn = { anchor: seen.anchor, focus: seen.focus };
    this.selection = { anchor, focus };
  };

  listen(): () => void {
    const onPointerDown = (event: PointerEvent) => {
      const scroller = this.scroller();
      // The scrollbar belongs to the scroller; using it keeps the selection.
      if (scroller && event.target === scroller) return;
      const inside = scroller ? event.composedPath().includes(scroller) : false;
      this.engaged = inside;
      this.caretKey = false;
      // A context menu click keeps the selection it opens on.
      if (inside && event.button !== 0) return;
      this.dragging = inside;
      this.drawn = null;
      // Shift-click extends from the existing anchor, even an offscreen one.
      if (!(inside && event.shiftKey)) this.selection = null;
    };
    const onPointerEnd = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.selection && this.selection.anchor === this.selection.focus) this.selection = null;
      this.redraw();
    };
    const onFocusIn = (event: FocusEvent) => {
      const scroller = this.scroller();
      // A modal sheet's popup takes focus when a click lands on the
      // unfocusable rows, which keeps the click's engagement.
      if (scroller && event.target instanceof Node && event.target.contains(scroller)) return;
      this.engaged = scroller ? event.composedPath().includes(scroller) : false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (CARET_KEYS.has(event.key)) {
        this.caretKey = this.engaged && !isEditableTarget(event.target);
        return;
      }
      if (
        event.key.toLowerCase() !== "a" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      if (!this.engaged || isEditableTarget(event.target)) return;
      event.preventDefault();
      this.selection = { anchor: 0, focus: this.text.length };
      this.redraw();
    };
    const onCopy = (event: ClipboardEvent) => {
      const source = this.selection;
      if (!source || source.anchor === source.focus || !event.clipboardData) return;
      if (isEditableTarget(document.activeElement)) return;
      const current = this.read();
      if (current === "outside") return;
      const drawnHere =
        current !== null &&
        (current.anchor.node !== current.focus.node ||
          current.anchor.offset !== current.focus.offset);
      // With nothing drawn, the selection is offscreen, and the copy is this
      // preview's only while the user is still working in it.
      if (!drawnHere && !this.engaged) return;
      event.clipboardData.setData(
        "text/plain",
        this.text.slice(
          Math.min(source.anchor, source.focus),
          Math.max(source.anchor, source.focus),
        ),
      );
      event.preventDefault();
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy, true);
    return () => {
      document.removeEventListener("selectionchange", this.onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerEnd, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
    };
  }
}

/**
 * Keeps the preview's text selection as source offsets. The virtualizer drops
 * offscreen rows, which collapses a DOM selection and limits select all and
 * copy to the rendered rows, so both read from the source text instead.
 */
export function useSourceTextSelection(text: string) {
  const [selection] = useState(() => new SourceTextSelection(text));
  useEffect(() => selection.listen(), [selection]);
  return selection.onPostRender;
}

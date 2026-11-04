import type { FileDiffMetadata, HunkExpansionRegion, PostRenderPhase } from "@pierre/diffs";
import { iterateOverDiff } from "@pierre/diffs/utils/iterateOverDiff";
import { useEffect, useState } from "react";

// A position in a file's rendered rows. Split views render the deletions
// column before the additions column, so `column` orders them; unified rows
// use column 0. `index` is the row's unified or split line index.
interface RowPoint {
  readonly column: 0 | 1;
  readonly index: number;
  readonly offset: number;
}

interface DomPoint {
  readonly node: Node;
  readonly offset: number;
}

interface DiffInstance {
  readonly fileDiff?: FileDiffMetadata | undefined;
  readonly options: {
    readonly diffStyle?: "unified" | "split";
    readonly expandUnchanged?: boolean;
    readonly collapsedContextThreshold?: number;
  };
}

// `hunksRenderer` is protected in Pierre's types; its map says which collapsed
// context the user expanded, which decides the rows that render.
function expandedHunks(instance: DiffInstance): Map<number, HunkExpansionRegion> | true {
  if (instance.options.expandUnchanged) return true;
  const { hunksRenderer } = instance as unknown as {
    hunksRenderer?: { getExpandedHunksMap(): Map<number, HunkExpansionRegion> };
  };
  return hunksRenderer?.getExpandedHunksMap() ?? new Map();
}

interface DiffTextSelection {
  readonly instance: DiffInstance;
  readonly fileDiff: FileDiffMetadata;
  readonly diffStyle: "unified" | "split";
  anchor: RowPoint | null;
  focus: RowPoint | null;
}

const FILE_START: RowPoint = { column: 0, index: -Infinity, offset: 0 };
const FILE_END: RowPoint = { column: 1, index: Infinity, offset: Infinity };

function compareRows(a: RowPoint, b: RowPoint): number {
  if (a.column !== b.column) return a.column - b.column;
  return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
}

function comparePoints(a: RowPoint, b: RowPoint): number {
  const rows = compareRows(a, b);
  if (rows !== 0) return rows;
  return a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0;
}

function samePoint(a: RowPoint | null, b: RowPoint | null): boolean {
  return a !== null && b !== null && comparePoints(a, b) === 0;
}

function lineText(line: string | undefined): string {
  if (!line?.endsWith("\n")) return line ?? "";
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.slice(0, -1);
}

// The text the browser would copy if every row between the points were
// mounted: each row's code, one line per row, in rendered order.
function selectedText(selection: DiffTextSelection, a: RowPoint, b: RowPoint): string {
  const [start, end] = comparePoints(a, b) <= 0 ? [a, b] : [b, a];
  const { fileDiff, diffStyle, instance } = selection;
  const columns: Array<Array<{ point: RowPoint; text: string }>> = [[], []];
  iterateOverDiff({
    diff: fileDiff,
    diffStyle,
    expandedHunks: expandedHunks(instance),
    collapsedContextThreshold: instance.options.collapsedContextThreshold ?? 1,
    callback: ({ deletionLine, additionLine }) => {
      if (diffStyle === "unified") {
        const line = additionLine ?? deletionLine;
        const text = additionLine
          ? fileDiff.additionLines[additionLine.lineIndex]
          : fileDiff.deletionLines[line.lineIndex];
        columns[0]!.push({
          point: { column: 0, index: line.unifiedLineIndex, offset: 0 },
          text: lineText(text),
        });
        return;
      }
      if (deletionLine) {
        columns[0]!.push({
          point: { column: 0, index: deletionLine.splitLineIndex, offset: 0 },
          text: lineText(fileDiff.deletionLines[deletionLine.lineIndex]),
        });
      }
      if (additionLine) {
        columns[1]!.push({
          point: { column: 1, index: additionLine.splitLineIndex, offset: 0 },
          text: lineText(fileDiff.additionLines[additionLine.lineIndex]),
        });
      }
    },
  });
  const lines: string[] = [];
  for (const { point, text } of [...columns[0]!, ...columns[1]!]) {
    if (compareRows(point, start) < 0 || compareRows(point, end) > 0) continue;
    const from = compareRows(point, start) === 0 ? start.offset : 0;
    const to = compareRows(point, end) === 0 ? end.offset : text.length;
    lines.push(text.slice(from, to));
  }
  return lines.join("\n");
}

function rowPoint(row: Element, offset: number): RowPoint | null {
  const [unified, split] = (row.getAttribute("data-line-index") ?? "").split(",").map(Number);
  const code = row.closest("code");
  if (!code || unified === undefined || split === undefined) return null;
  if (code.hasAttribute("data-unified")) return { column: 0, index: unified, offset };
  return { column: code.hasAttribute("data-additions") ? 1 : 0, index: split, offset };
}

// Only points inside a row carry a position. A point the browser moved to a
// container because its row was virtualized away does not.
function domToRowPoint({ node, offset }: DomPoint): RowPoint | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest("[data-line]");
  if (!row) return null;
  const prefix = document.createRange();
  prefix.setStart(row, 0);
  prefix.setEnd(node, offset);
  // Empty rows render a "\n" placeholder.
  const text = row.textContent === "\n" ? "" : (row.textContent ?? "");
  return rowPoint(row, Math.min(prefix.toString().length, text.length));
}

// A point outside the rows, such as in the file header, selects up to the
// nearest row boundary on the anchor's side. Virtualization only removes
// elements inside the `pre`, so a point it relocated lands on one of those.
function betweenRowsPoint(root: ShadowRoot, point: DomPoint, anchor: RowPoint): RowPoint | null {
  if (point.node instanceof Element && point.node.closest("pre")) return null;
  const at = document.createRange();
  at.setStart(point.node, point.offset);
  let before: Element | undefined;
  for (const row of root.querySelectorAll("[data-line]")) {
    if (at.comparePoint(row, 0) > 0) {
      const after = rowPoint(row, 0);
      const forward = before && after && compareRows(anchor, after) < 0;
      if (!forward) return after;
      break;
    }
    before = row;
  }
  return before ? domToRowPoint(rowToDomPoint(before, Infinity)) : null;
}

function rowToDomPoint(row: Element, offset: number): DomPoint {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.length) return { node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : { node: row, offset: 0 };
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
// selection is in this file. Undirected selections report their start as the
// anchor.
function readDomSelection(
  root: ShadowRoot,
): { anchor: DomPoint; focus: DomPoint; directed: boolean } | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  let range: AbstractRange | null;
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
        directed: true,
      };
    }
    range = selection.getRangeAt(0);
  }
  const start = { node: range.startContainer, offset: range.startOffset };
  const end = { node: range.endContainer, offset: range.endOffset };
  // macOS Chromium reports mouse selections with direction "none".
  const directed = selection.direction !== "none";
  return selection.direction === "backward"
    ? { anchor: end, focus: start, directed }
    : { anchor: start, focus: end, directed };
}

// The end of an undirected range that is not the gesture's anchor.
function undirectedFocus(
  anchor: RowPoint,
  start: RowPoint | null,
  end: RowPoint | null,
): RowPoint | null {
  if (start && end) return comparePoints(anchor, start) <= 0 ? end : start;
  const seen = start ?? end;
  return samePoint(seen, anchor) ? null : seen;
}

// Select All from a menu runs no keydown. With the caret in a file it selects
// that file's mounted rows, otherwise the whole document.
function selectsWholeFile(host: HTMLElement): boolean {
  const root = host.shadowRoot;
  const code = root?.querySelector("pre");
  const current = root ? readDomSelection(root) : null;
  if (!root || !code || !current) return false;
  const inAnchor = root.contains(current.anchor.node);
  const inFocus = root.contains(current.focus.node);
  if (!inAnchor && !inFocus) return document.getSelection()?.containsNode(host) ?? false;
  if (!inAnchor || !inFocus) return false;
  const selected = document.createRange();
  selected.setStart(current.anchor.node, current.anchor.offset);
  selected.setEnd(current.focus.node, current.focus.offset);
  if (selected.collapsed) {
    selected.setStart(current.focus.node, current.focus.offset);
    selected.setEnd(current.anchor.node, current.anchor.offset);
  }
  const all = document.createRange();
  all.selectNodeContents(code);
  return (
    selected.compareBoundaryPoints(Range.START_TO_START, all) <= 0 &&
    selected.compareBoundaryPoints(Range.END_TO_END, all) >= 0
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

class DiffTextSelectionTracker {
  hosts = new Map<HTMLElement, DiffInstance>();
  scroller: Element | null = null;
  selection: DiffTextSelection | null = null;
  // The clamped range redraw last drew, so reading it back keeps the
  // offscreen endpoints it stands for.
  drawn: { anchor: RowPoint | null; focus: RowPoint | null } | null = null;
  // A pointer gesture that started here is selecting; the browser owns the
  // drawn selection until it ends.
  dragging = false;
  // The file of the last pointer or focus interaction, which owns select all
  // and the copy of a selection scrolled out of the mounted rows.
  engaged: DiffInstance | null = null;

  hostOf(instance: DiffInstance): HTMLElement | null {
    for (const [host, mounted] of this.hosts) if (mounted === instance) return host;
    return null;
  }

  begin(instance: DiffInstance): DiffTextSelection | null {
    const { fileDiff } = instance;
    if (!fileDiff) return null;
    const diffStyle = instance.options.diffStyle ?? "split";
    return { instance, fileDiff, diffStyle, anchor: null, focus: null };
  }

  onPostRender = (node: HTMLElement, instance: DiffInstance, phase: PostRenderPhase) => {
    if (phase === "unmount") {
      if (this.hosts.get(node) === instance) this.hosts.delete(node);
      return;
    }
    this.hosts.set(node, instance);
    // StyledDiffCodeView gives CodeView's scroll container this class.
    this.scroller ??= node.closest(".diff-render-surface");
    const { selection } = this;
    if (selection?.instance !== instance) return;
    if (
      instance.fileDiff !== selection.fileDiff ||
      (instance.options.diffStyle ?? "split") !== selection.diffStyle
    ) {
      this.selection = null;
      return;
    }
    if (!this.dragging) this.redraw();
  };

  // Draws the part of the selection that falls in the mounted rows.
  redraw() {
    const { selection } = this;
    const root = selection ? this.hostOf(selection.instance)?.shadowRoot : null;
    const domSelection = document.getSelection();
    if (!selection?.anchor || !selection.focus || !root || !domSelection) return;
    const rows = [...root.querySelectorAll("[data-line]")].flatMap((row) => {
      const point = rowPoint(row, 0);
      return point ? [{ row, point }] : [];
    });
    if (rows.length === 0) return;
    const clamp = (target: RowPoint): { point: RowPoint; dom: DomPoint } => {
      let before: (typeof rows)[number] | undefined;
      for (const entry of rows) {
        const order = compareRows(entry.point, target);
        if (order === 0) {
          const dom = rowToDomPoint(entry.row, target.offset);
          return { point: domToRowPoint(dom) ?? target, dom };
        }
        if (order > 0) break;
        before = entry;
      }
      const row = before ?? rows[0]!;
      const dom = rowToDomPoint(row.row, before ? Infinity : 0);
      return { point: domToRowPoint(dom) ?? row.point, dom };
    };
    const anchor = clamp(selection.anchor);
    const focus = clamp(selection.focus);
    this.drawn = { anchor: anchor.point, focus: focus.point };
    const current = readDomSelection(root);
    if (samePoint(anchor.point, focus.point)) {
      if (current) domSelection.removeAllRanges();
      return;
    }
    if (
      current &&
      root.contains(current.anchor.node) &&
      samePoint(domToRowPoint(current.anchor), anchor.point) &&
      samePoint(domToRowPoint(current.focus), focus.point)
    ) {
      return;
    }
    domSelection.setBaseAndExtent(
      anchor.dom.node,
      anchor.dom.offset,
      focus.dom.node,
      focus.dom.offset,
    );
  }

  selectFile(instance: DiffInstance): boolean {
    // A collapsed or unmounted file shows nothing to select.
    if (!this.hostOf(instance)?.shadowRoot?.querySelector("[data-line]")) return false;
    const selection = this.begin(instance);
    if (!selection) return false;
    selection.anchor = FILE_START;
    selection.focus = FILE_END;
    this.selection = selection;
    this.redraw();
    return true;
  }

  onSelectionChange = () => {
    // Several ranges (Firefox's Ctrl-drag) stay the browser's to draw and copy.
    if ((document.getSelection()?.rangeCount ?? 0) > 1) {
      this.selection = null;
      return;
    }
    const { engaged } = this;
    const engagedHost = engaged && !this.dragging ? this.hostOf(engaged) : null;
    if (engaged && engagedHost && selectsWholeFile(engagedHost) && this.selectFile(engaged)) {
      return;
    }
    const instance = this.selection?.instance ?? engaged;
    const host = instance ? this.hostOf(instance) : null;
    if (!instance || !host?.shadowRoot) return;
    const current = readDomSelection(host.shadowRoot);
    if (!current) return;
    const root = host.shadowRoot;
    if (!root.contains(current.anchor.node) || !root.contains(current.focus.node)) {
      // The selection left this file while it is still mounted, so the
      // browser's own selection and copy apply, even mid-gesture.
      this.selection = null;
      return;
    }
    let seenAnchor = domToRowPoint(current.anchor);
    let seenFocus = domToRowPoint(current.focus);
    const selection =
      this.selection?.instance === instance
        ? this.selection
        : (this.selection = this.begin(instance));
    if (!selection) return;
    const { drawn } = this;
    if (this.dragging) {
      // The anchor stays where the gesture began; the browser's drifts once
      // its row is virtualized away.
      selection.anchor ??= seenAnchor;
      const { anchor } = selection;
      if (anchor) {
        seenFocus ??= betweenRowsPoint(root, current.focus, anchor);
        if (!current.directed) seenAnchor ??= betweenRowsPoint(root, current.anchor, anchor);
      }
      const focus =
        current.directed || !anchor ? seenFocus : undirectedFocus(anchor, seenAnchor, seenFocus);
      selection.focus = focus ?? selection.focus;
    } else {
      if (
        !current.directed &&
        (samePoint(seenAnchor, drawn?.focus ?? null) || samePoint(seenFocus, drawn?.anchor ?? null))
      ) {
        [seenAnchor, seenFocus] = [seenFocus, seenAnchor];
      }
      if (seenAnchor && seenFocus && samePoint(seenAnchor, seenFocus)) {
        this.selection = null;
        return;
      }
      // An endpoint still where redraw clamped it stands for the offscreen one.
      if (seenAnchor && !samePoint(seenAnchor, drawn?.anchor ?? null))
        selection.anchor = seenAnchor;
      if (seenFocus && !samePoint(seenFocus, drawn?.focus ?? null)) selection.focus = seenFocus;
      this.drawn = {
        anchor: seenAnchor ?? drawn?.anchor ?? null,
        focus: seenFocus ?? drawn?.focus ?? null,
      };
      return;
    }
    this.drawn = null;
  };

  engagedFrom(event: Event): DiffInstance | null {
    for (const target of event.composedPath()) {
      const instance = target instanceof HTMLElement ? this.hosts.get(target) : undefined;
      if (instance) return instance;
    }
    return null;
  }

  listen(): () => void {
    const onPointerDown = (event: PointerEvent) => {
      // The scrollbar belongs to the scroller; using it keeps the selection.
      if (this.scroller && event.target === this.scroller) return;
      this.engaged = this.engagedFrom(event);
      // A context menu click keeps the selection it opens on.
      if (this.engaged && event.button !== 0) return;
      this.dragging = this.engaged !== null;
      this.drawn = null;
      // Shift-click extends from the existing anchor, even an offscreen one.
      if (!(this.engaged && event.shiftKey)) this.selection = null;
    };
    // An undirected drag's first selectionchange can be coalesced away, so the
    // press records where it began. A multi-click's later presses select words.
    const onMouseDown = (event: MouseEvent) => {
      const { engaged } = this;
      if (!engaged || !this.dragging || event.shiftKey || event.detail !== 1) return;
      const root = this.hostOf(engaged)?.shadowRoot;
      const caret =
        root &&
        document.caretPositionFromPoint?.(event.clientX, event.clientY, { shadowRoots: [root] });
      const anchor = caret ? domToRowPoint({ node: caret.offsetNode, offset: caret.offset }) : null;
      const selection = anchor ? this.begin(engaged) : null;
      if (selection) this.selection = { ...selection, anchor };
    };
    const onPointerEnd = () => {
      if (!this.dragging) return;
      // The gesture's last selectionchange may still be queued.
      this.onSelectionChange();
      this.dragging = false;
      this.redraw();
    };
    const onFocusIn = (event: FocusEvent) => {
      // Clicking a row focuses the scroller, which keeps the click's file.
      if (this.scroller && event.target === this.scroller) return;
      this.engaged = this.engagedFrom(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "a" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        !this.engaged ||
        isEditableTarget(event.composedPath()[0] ?? null)
      ) {
        return;
      }
      if (this.selectFile(this.engaged)) event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      const { selection } = this;
      if (!selection?.anchor || !selection.focus || !event.clipboardData) return;
      if (samePoint(selection.anchor, selection.focus)) return;
      if (isEditableTarget(event.composedPath()[0] ?? null)) return;
      const root = this.hostOf(selection.instance)?.shadowRoot;
      const current = root ? readDomSelection(root) : null;
      const drawnHere =
        root !== null &&
        root !== undefined &&
        current !== null &&
        root.contains(current.anchor.node) &&
        (current.anchor.node !== current.focus.node ||
          current.anchor.offset !== current.focus.offset);
      // With nothing drawn, the selection is scrolled away, and the copy is
      // this file's only while the user is still working in it.
      if (!drawnHere && this.engaged !== selection.instance) return;
      event.clipboardData.setData(
        "text/plain",
        selectedText(selection, selection.anchor, selection.focus),
      );
      event.preventDefault();
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy, true);
    return () => {
      document.removeEventListener("selectionchange", this.onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerEnd, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
    };
  }
}

/**
 * Keeps a diff's text selection as row positions. CodeView virtualizes rows,
 * which collapses a DOM selection and limits select all and copy to the
 * mounted rows, so both read from the file's diff metadata instead.
 */
export function useDiffTextSelection() {
  const [tracker] = useState(() => new DiffTextSelectionTracker());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document selection, keyboard and clipboard listeners held while mounted
  useEffect(() => tracker.listen(), [tracker]);
  return tracker.onPostRender;
}

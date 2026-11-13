import { type ClipboardEvent, useEffect, useRef } from "react";

// A row's place in its file: split view orders the deletions column before the additions column.
interface RowPosition {
  readonly side: number;
  readonly index: number;
}

interface RowPoint extends RowPosition {
  readonly offset: number;
}

interface TrackedSelection {
  readonly root: ShadowRoot;
  readonly start: RowPoint;
  readonly end: RowPoint;
  /** Text of every selected row seen while mounted, so rows the virtualizer unmounts still copy. */
  readonly rows: Map<string, RowPosition & { readonly text: string }>;
  /** Made by a drag, whose native selection can no longer be trusted once rows unmount. */
  readonly dragged: boolean;
}

const ROW = "[data-line][data-line-index]";

function rowPosition(row: HTMLElement): RowPosition {
  const [unifiedIndex = 0, splitIndex = 0] = (row.dataset.lineIndex ?? "").split(",").map(Number);
  const code = row.closest<HTMLElement>("code");
  if (code?.dataset.unified !== undefined) return { side: 0, index: unifiedIndex };
  return { side: code?.dataset.additions !== undefined ? 1 : 0, index: splitIndex };
}

const keyOf = (position: RowPosition) => `${position.side}:${position.index}`;

function compare(a: RowPosition, b: RowPosition) {
  return a.side - b.side || a.index - b.index;
}

function comparePoints(a: RowPoint, b: RowPoint) {
  return compare(a, b) || a.offset - b.offset;
}

function rowPoint(node: Node, offset: number): RowPoint | null {
  const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(ROW);
  if (!row) return null;
  const range = document.createRange();
  range.setStart(row, 0);
  range.setEnd(node, offset);
  return { ...rowPosition(row), offset: range.toString().length };
}

/** The selection when it lies within one file's shadow tree. */
function selectionInFile(roots: ShadowRoot[]) {
  try {
    const selected = document.getSelection()?.getComposedRanges({ shadowRoots: roots })[0];
    if (!selected) return null;
    const root = selected.startContainer.getRootNode();
    if (!(root instanceof ShadowRoot) || !roots.includes(root)) return null;
    if (selected.endContainer.getRootNode() !== root) return null;
    return { root, selected };
  } catch {
    // Engines without composed ranges keep their own copy.
    return null;
  }
}

function mountedRows(root: ShadowRoot) {
  return Array.from(root.querySelectorAll<HTMLElement>(ROW), (row) => ({
    row,
    position: rowPosition(row),
  }));
}

/**
 * The diff viewer mounts only rows near the viewport, and rows it unmounts drop out of a dragged
 * selection. Keeps the selected rows' text so copying returns the whole selection.
 */
export function useDiffSelectionCopy() {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<TrackedSelection | null>(null);
  // Chromium loses a drag's anchor once the viewer unmounts its row and re-anchors on whatever is
  // mounted, so while the button is held the selection runs between the carets under the pointer
  // where it went down and where it is now.
  const pressRef = useRef<{
    root: ShadowRoot;
    anchor: RowPoint;
    focus: RowPoint;
    x: number;
    y: number;
    rows: TrackedSelection["rows"];
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the document selection, which lives outside React
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const fileRoots = () =>
      Array.from(container.querySelectorAll("diffs-container"), (host) => host.shadowRoot).filter(
        (root): root is ShadowRoot => root !== null,
      );
    const caretAt = (x: number, y: number) => {
      const roots = fileRoots();
      const caret = document.caretPositionFromPoint?.(x, y, { shadowRoots: roots });
      const root = caret?.offsetNode.getRootNode();
      if (!caret || !(root instanceof ShadowRoot) || !roots.includes(root)) return null;
      const point = rowPoint(caret.offsetNode, caret.offset);
      return point && { root, point };
    };
    const record = (
      root: ShadowRoot,
      rows: TrackedSelection["rows"],
      within?: { start: RowPoint; end: RowPoint },
    ) => {
      for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
        const position = rowPosition(row);
        if (within && (compare(position, within.start) < 0 || compare(position, within.end) > 0)) {
          continue;
        }
        rows.set(keyOf(position), { ...position, text: row.textContent ?? "" });
      }
    };
    const track = () => {
      const press = pressRef.current;
      if (press) {
        if (!press.root.isConnected) return;
        const caret = caretAt(press.x, press.y);
        if (caret?.root === press.root) press.focus = caret.point;
        // Mid-drag, rows past the focus can unmount before the focus reaches them.
        record(press.root, press.rows);
        const order = comparePoints(press.anchor, press.focus);
        selectionRef.current =
          order === 0
            ? null
            : {
                root: press.root,
                start: order < 0 ? press.anchor : press.focus,
                end: order < 0 ? press.focus : press.anchor,
                rows: press.rows,
                dragged: true,
              };
        return;
      }
      // After the button is released the native selection may still hold the lost anchor.
      if (selectionRef.current?.dragged) return;
      const found = selectionInFile(fileRoots());
      if (!found || found.selected.collapsed) {
        selectionRef.current = null;
        return;
      }
      const { root, selected } = found;
      const previous = selectionRef.current?.root === root ? selectionRef.current : null;
      const mounted = new Set(mountedRows(root).map(({ position }) => keyOf(position)));
      const evicted = (point: RowPoint | undefined) =>
        point && !mounted.has(keyOf(point)) ? point : null;
      const start =
        rowPoint(selected.startContainer, selected.startOffset) ?? evicted(previous?.start);
      const end = rowPoint(selected.endContainer, selected.endOffset) ?? evicted(previous?.end);
      if (!start || !end) {
        selectionRef.current = null;
        return;
      }
      const rows = previous?.rows ?? new Map();
      record(root, rows, { start, end });
      selectionRef.current = { root, start, end, rows, dragged: false };
    };
    const press = (event: PointerEvent) => {
      selectionRef.current = null;
      pressRef.current = null;
      if (event.button !== 0) return;
      const caret = caretAt(event.clientX, event.clientY);
      if (!caret) return;
      pressRef.current = {
        root: caret.root,
        anchor: caret.point,
        focus: caret.point,
        x: event.clientX,
        y: event.clientY,
        rows: new Map(),
      };
      track();
    };
    const move = (event: PointerEvent) => {
      if (!pressRef.current) return;
      pressRef.current.x = event.clientX;
      pressRef.current.y = event.clientY;
      track();
    };
    const release = () => {
      if (!pressRef.current) return;
      track();
      pressRef.current = null;
    };
    document.addEventListener("selectionchange", track);
    // Scrolling queues the render that unmounts rows; record the selection while they are still there.
    container.addEventListener("scroll", track, { capture: true, passive: true });
    container.addEventListener("pointerdown", press);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    return () => {
      document.removeEventListener("selectionchange", track);
      container.removeEventListener("scroll", track, { capture: true });
      container.removeEventListener("pointerdown", press);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
    };
  }, []);

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = selectionRef.current;
    if (!selection?.root.isConnected) return;
    const mounted = new Set(mountedRows(selection.root).map(({ position }) => keyOf(position)));
    if (mounted.has(keyOf(selection.start)) && mounted.has(keyOf(selection.end))) return;
    const { start, end } = selection;
    const text = Array.from(selection.rows.values())
      .filter((row) => compare(row, start) >= 0 && compare(row, end) <= 0)
      .toSorted(compare)
      .map((row) => {
        const from = compare(row, start) === 0 ? start.offset : 0;
        return compare(row, end) === 0 ? row.text.slice(from, end.offset) : row.text.slice(from);
      })
      .join("\n");
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };

  return { containerRef, onCopy };
}

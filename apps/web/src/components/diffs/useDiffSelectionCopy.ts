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
    if (!selected || selected.collapsed) return null;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the document selection, which lives outside React
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const track = () => {
      const roots = Array.from(
        container.querySelectorAll("diffs-container"),
        (host) => host.shadowRoot,
      ).filter((root): root is ShadowRoot => root !== null);
      const found = selectionInFile(roots);
      if (!found) {
        selectionRef.current = null;
        return;
      }
      const { root, selected } = found;
      const previous = selectionRef.current?.root === root ? selectionRef.current : null;
      const rows = mountedRows(root);
      const mounted = new Set(rows.map(({ position }) => keyOf(position)));
      const evicted = (point: RowPoint | undefined) =>
        point && !mounted.has(keyOf(point)) ? point : null;
      const start =
        rowPoint(selected.startContainer, selected.startOffset) ?? evicted(previous?.start);
      const end = rowPoint(selected.endContainer, selected.endOffset) ?? evicted(previous?.end);
      if (!start || !end) {
        selectionRef.current = null;
        return;
      }
      const tracked = { root, start, end, rows: previous?.rows ?? new Map() };
      for (const { row, position } of rows) {
        if (compare(position, start) >= 0 && compare(position, end) <= 0) {
          tracked.rows.set(keyOf(position), { ...position, text: row.textContent ?? "" });
        }
      }
      selectionRef.current = tracked;
    };
    document.addEventListener("selectionchange", track);
    // Scrolling queues the render that unmounts rows; record the selection while they are still there.
    container.addEventListener("scroll", track, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", track);
      container.removeEventListener("scroll", track, { capture: true });
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

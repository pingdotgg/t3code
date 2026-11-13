import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { type ClipboardEvent, useEffect, useRef } from "react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/** The selection inside the file's shadow tree, or null when it lies elsewhere. */
function selectionInside(root: ShadowRoot) {
  try {
    const selected = document.getSelection()?.getComposedRanges({ shadowRoots: [root] })[0];
    if (!selected) return null;
    if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) {
      return null;
    }
    const range = document.createRange();
    range.setStart(selected.startContainer, selected.startOffset);
    range.setEnd(selected.endContainer, selected.endOffset);
    return range;
  } catch {
    // Engines without composed ranges keep their own copy.
    return null;
  }
}

/** Select All spans the file's shadow tree, where the virtualizer mounts only rows near the viewport. */
function selectsEveryMountedRow(root: ShadowRoot) {
  const rows = root.querySelectorAll("[data-line]");
  const first = rows[0];
  const last = rows[rows.length - 1];
  const range = selectionInside(root);
  if (!first || !last || !range) return false;
  // A dragged selection ends inside rows, so it never holds a row's own boundaries.
  return (
    range.comparePoint(first, 0) === 0 && range.comparePoint(last, last.childNodes.length) === 0
  );
}

interface LinePoint {
  readonly line: number;
  readonly column: number;
}

function linePoint(node: Node, offset: number): LinePoint | null {
  const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    "[data-line]",
  );
  if (!row) return null;
  const range = document.createRange();
  range.setStart(row, 0);
  range.setEnd(node, offset);
  return { line: Number(row.dataset.line), column: range.toString().length };
}

function compareLinePoints(a: LinePoint, b: LinePoint) {
  return a.line - b.line || a.column - b.column;
}

function isMounted(root: ShadowRoot, point: LinePoint) {
  return root.querySelector(`[data-line="${point.line}"]`) !== null;
}

function textOffset(text: string, point: LinePoint) {
  let lineStart = 0;
  for (let line = 1; line < point.line; line++) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) return text.length;
    lineStart = newline + 1;
  }
  const lineEnd = text.indexOf("\n", lineStart);
  return Math.min(lineStart + point.column, lineEnd === -1 ? text.length : lineEnd);
}

export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const resolvedTheme = useRenderedAppearance();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  const containerRef = useRef<HTMLDivElement>(null);
  // The selection as file positions, so an end whose row the virtualizer unmounts is still known.
  const selectionRef = useRef<{ start: LinePoint; end: LinePoint; dragged: boolean } | null>(null);
  // Chromium loses a drag's anchor once the virtualizer unmounts its row and re-anchors on whatever
  // is mounted, so while the button is held the selection runs between the carets under the pointer
  // where it went down and where it is now.
  const pressRef = useRef<{
    anchor: LinePoint | null;
    focus: LinePoint | null;
    x: number;
    y: number;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the document selection, which lives outside React
  useEffect(() => {
    const shadowRoot = () => containerRef.current?.querySelector("diffs-container")?.shadowRoot;
    const caretAt = (root: ShadowRoot, x: number, y: number) => {
      const caret = document.caretPositionFromPoint?.(x, y, { shadowRoots: [root] });
      return caret && root.contains(caret.offsetNode)
        ? linePoint(caret.offsetNode, caret.offset)
        : null;
    };
    const track = () => {
      const root = shadowRoot();
      const press = pressRef.current;
      if (root && press) {
        press.focus = caretAt(root, press.x, press.y) ?? press.focus;
        const { anchor, focus } = press;
        const order = anchor && focus ? compareLinePoints(anchor, focus) : 0;
        selectionRef.current =
          !anchor || !focus || order === 0
            ? null
            : order < 0
              ? { start: anchor, end: focus, dragged: true }
              : { start: focus, end: anchor, dragged: true };
        return;
      }
      const range = root ? selectionInside(root) : null;
      if (!root || !range) {
        selectionRef.current = null;
        return;
      }
      // After the button is released the native selection may still hold the lost anchor.
      if (selectionRef.current?.dragged) return;
      if (range.collapsed) {
        selectionRef.current = null;
        return;
      }
      const previous = selectionRef.current;
      const evicted = (point: LinePoint | undefined) =>
        point && !isMounted(root, point) ? point : null;
      const start = linePoint(range.startContainer, range.startOffset) ?? evicted(previous?.start);
      const end = linePoint(range.endContainer, range.endOffset) ?? evicted(previous?.end);
      selectionRef.current = start && end ? { start, end, dragged: false } : null;
    };
    const press = (event: PointerEvent) => {
      selectionRef.current = null;
      const root = shadowRoot();
      if (event.button !== 0 || !root) return;
      const anchor = caretAt(root, event.clientX, event.clientY);
      pressRef.current = { anchor, focus: anchor, x: event.clientX, y: event.clientY };
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
    const container = containerRef.current;
    document.addEventListener("selectionchange", track);
    // Scrolling queues the render that unmounts rows; record the selection while they are still there.
    container?.addEventListener("scroll", track, { capture: true, passive: true });
    container?.addEventListener("pointerdown", press);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    return () => {
      document.removeEventListener("selectionchange", track);
      container?.removeEventListener("scroll", track, { capture: true });
      container?.removeEventListener("pointerdown", press);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
    };
  }, []);
  const copy = (event: ClipboardEvent<HTMLDivElement>) => {
    const root = event.currentTarget.querySelector("diffs-container")?.shadowRoot;
    if (!root) return;
    if (selectsEveryMountedRow(root)) {
      event.clipboardData.setData("text/plain", props.text);
      event.preventDefault();
      return;
    }
    const selection = selectionRef.current;
    if (!selection || (isMounted(root, selection.start) && isMounted(root, selection.end))) return;
    const offsets = [
      textOffset(props.text, selection.start),
      textOffset(props.text, selection.end),
    ];
    event.clipboardData.setData(
      "text/plain",
      props.text.slice(Math.min(...offsets), Math.max(...offsets)),
    );
    event.preventDefault();
  };
  return (
    <DiffWorkerPoolProvider>
      <div ref={containerRef} className="contents" onCopy={copy}>
        <Virtualizer
          key={`${props.name}:${resolvedTheme}:${props.text.length}`}
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={{
              name: props.name,
              contents: props.text,
              ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
            }}
            options={{
              disableFileHeader: true,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
              ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
}

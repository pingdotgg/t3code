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
  const selectionRef = useRef<{ start: LinePoint; end: LinePoint } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the document selection, which lives outside React
  useEffect(() => {
    const track = () => {
      const root = containerRef.current?.querySelector("diffs-container")?.shadowRoot;
      const range = root ? selectionInside(root) : null;
      if (!root || !range || range.collapsed) {
        selectionRef.current = null;
        return;
      }
      const previous = selectionRef.current;
      const evicted = (point: LinePoint | undefined) =>
        point && !isMounted(root, point) ? point : null;
      const start = linePoint(range.startContainer, range.startOffset) ?? evicted(previous?.start);
      const end = linePoint(range.endContainer, range.endOffset) ?? evicted(previous?.end);
      selectionRef.current = start && end ? { start, end } : null;
    };
    const container = containerRef.current;
    document.addEventListener("selectionchange", track);
    // Scrolling queues the render that unmounts rows; record the selection while they are still there.
    container?.addEventListener("scroll", track, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", track);
      container?.removeEventListener("scroll", track, { capture: true });
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

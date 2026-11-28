import type { ScopedThreadRef } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { normalizeMarkdownFragmentId } from "~/components/chat/markdownFragments";
import { Spinner } from "~/components/ui/spinner";
import { isMacPlatform } from "~/lib/utils";
import type { MarkdownExtensions } from "~/markdown/wordsHast";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { createPositionMemory, previewPositionKey } from "./previewPosition";
import {
  buildMarkdownFootnotesSection,
  findFootnoteRefChunkIndex,
  joinMarkdownChunks,
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  type MarkdownFootnotes,
  type MarkdownFootnotesSection,
  prepareMarkdownChunk,
} from "@t3tools/shared/markdownChunks";

const ESTIMATED_LINE_PX = 24;
const FOOTNOTE_TARGET_ID = /^fn-\d+$/;
const FOOTNOTE_REF_ID = /^fnref-(\d+)(?:-(\d+))?$/;

const CHUNK_FOOTNOTES_OMIT: MarkdownExtensions = { footnotes: "omit" };
const CHUNK_FOOTNOTES_OMIT_SEEDED: MarkdownExtensions = { footnotes: "omit-seeded" };
const CHUNK_FOOTNOTES_ONLY: MarkdownExtensions = { footnotes: "only" };

const savedPositions = createPositionMemory<{
  readonly index: number;
  readonly viewOffset: number;
}>();

type ChunkItem =
  | {
      readonly kind: "chunk";
      readonly index: number;
      readonly start: number;
      readonly chunk: MarkdownChunk;
    }
  | {
      readonly kind: "footnotes";
      readonly index: number;
      readonly section: MarkdownFootnotesSection;
    };

function findScopedFragmentTarget(
  container: HTMLElement,
  normalizedId: string,
): HTMLElement | null {
  for (const element of container.querySelectorAll<HTMLElement>("[id]")) {
    if (normalizeMarkdownFragmentId(element.id) === normalizedId) return element;
  }
  return null;
}

function selectRenderedContentOnSelectAll(event: ReactKeyboardEvent<HTMLElement>) {
  const mac = isMacPlatform(navigator.platform);
  const selectAll =
    event.key.toLowerCase() === "a" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.shiftKey &&
    !event.altKey;
  // React bubbles keys from portaled children (the image dialog) through this surface.
  if (
    !selectAll ||
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  event.preventDefault();
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

/** Renders Markdown pieces in a virtualized list; task offsets are file offsets. */
export function ChunkedMarkdown(props: {
  readonly chunks: readonly MarkdownChunk[];
  /** Link definitions from the whole file, so references resolve across pieces. */
  readonly definitions: string;
  /** Document-wide footnote metadata so references and definitions resolve across pieces. */
  readonly footnotes?: MarkdownFootnotes | undefined;
  /** Shows a spinner after the last chunk while more of the file streams in. */
  readonly loading?: boolean;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const { chunks, onTaskListChange } = props;
  const items: ChunkItem[] = [];
  let start = 0;
  let lines = 0;
  for (const [index, chunk] of chunks.entries()) {
    items.push({ kind: "chunk", index, start, chunk });
    lines += chunk.lines;
    start += chunk.text.length + 1;
  }
  const footnotesSection = buildMarkdownFootnotesSection(props.definitions, props.footnotes);
  const footnotesItemIndex = footnotesSection !== null ? items.length : null;
  if (footnotesSection !== null) {
    items.push({ kind: "footnotes", index: items.length, section: footnotesSection });
  }
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const positionKey = previewPositionKey(
    props.threadRef.environmentId,
    props.threadRef.threadId,
    props.cwd,
    props.relativePath,
  );
  const saved = savedPositions.get(positionKey);
  // The list applies its initial index once, so wait for the saved chunk to stream in.
  const awaitingSaved = props.loading && saved !== undefined && saved.index >= items.length;
  const spinner = (
    <div className="flex justify-center py-4">
      <Spinner size="md" tone="muted" />
    </div>
  );
  if (awaitingSaved) return spinner;

  const handleFragmentClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Without shared footnotes each piece keeps its own section, which ChatMarkdown resolves.
    if (
      !props.footnotes ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    const container = containerRef.current;
    if (!container) return;

    const normalizedId = normalizeMarkdownFragmentId(href);
    const isFootnoteTarget = FOOTNOTE_TARGET_ID.test(normalizedId);
    const refMatch = isFootnoteTarget ? null : FOOTNOTE_REF_ID.exec(normalizedId);
    if (!isFootnoteTarget && !refMatch) return;

    const local = findScopedFragmentTarget(container, normalizedId);
    if (local) {
      event.preventDefault();
      event.stopPropagation();
      local.scrollIntoView({ block: "start" });
      return;
    }

    let targetIndex: number | null = null;
    if (isFootnoteTarget) {
      targetIndex = footnotesItemIndex;
    } else if (refMatch) {
      const fnNumber = Number(refMatch[1]);
      const occurrence = refMatch[2] ? Number(refMatch[2]) : 1;
      targetIndex = findFootnoteRefChunkIndex(props.footnotes, fnNumber, occurrence);
    }
    if (targetIndex === null || !listRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    void listRef.current
      .scrollToIndex({ index: targetIndex, viewPosition: 0, animated: false })
      .then(() => {
        const mounted = containerRef.current
          ? findScopedFragmentTarget(containerRef.current, normalizedId)
          : null;
        mounted?.scrollIntoView({ block: "start" });
      });
  };

  const extraData = props.footnotes
    ? `${props.definitions}\0${props.footnotes.stubs}\0${props.footnotes.definitions}\0${props.footnotes.chunkRefs.map((refs) => refs.join(",")).join("|")}`
    : props.definitions;

  return (
    <div
      ref={containerRef}
      // Clicking the text focuses the preview, so Select All stays inside it.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onClickCapture={handleFragmentClickCapture}
      onKeyDown={selectRenderedContentOnSelectAll}
      onCopy={(event) => {
        // Select All only reaches rendered pieces; copying all of it copies the whole file.
        const list = event.currentTarget.firstElementChild;
        const selection = window.getSelection();
        if (!list || !selection?.rangeCount) return;
        // Chromium's containsNode says false for a list selected through its parent's children.
        const range = selection.getRangeAt(0);
        const listRange = document.createRange();
        listRange.selectNode(list);
        if (
          range.compareBoundaryPoints(Range.START_TO_START, listRange) > 0 ||
          range.compareBoundaryPoints(Range.END_TO_END, listRange) < 0
        ) {
          return;
        }
        event.preventDefault();
        // A rendered piece's own handler already wrote just its part.
        event.clipboardData.clearData();
        event.clipboardData.setData("text/plain", joinMarkdownChunks(chunks));
      }}
    >
      <LegendList<ChunkItem>
        // The panel keeps this mounted across threads; the initial index only applies on mount.
        key={positionKey}
        ref={listRef}
        data={items}
        {...(saved && {
          initialScrollIndex: {
            index: Math.min(saved.index, Math.max(items.length - 1, 0)),
            viewOffset: saved.viewOffset,
          },
        })}
        onScroll={() => {
          const list = listRef.current?.getState();
          if (!list) return;
          savedPositions.set(positionKey, {
            index: list.start,
            viewOffset: list.positionAtIndex(list.start) - list.scroll,
          });
        }}
        extraData={extraData}
        keyExtractor={(item) => (item.kind === "footnotes" ? "footnotes" : String(item.index))}
        estimatedItemSize={(lines / Math.max(items.length, 1)) * ESTIMATED_LINE_PX}
        drawDistance={800}
        recycleItems={false}
        className="h-full scrollbar-gutter-both"
        contentContainerClassName="py-5"
        ListFooterComponent={props.loading ? spinner : null}
        renderItem={({ item }) => {
          if (item.kind === "footnotes") {
            return (
              <div className="pb-5">
                <FileMarkdownPreview
                  text={item.section.text}
                  cwd={props.cwd}
                  relativePath={props.relativePath}
                  threadRef={props.threadRef}
                  workspaceMutationId={props.workspaceMutationId}
                  className="mx-auto max-w-4xl px-6"
                  extensions={CHUNK_FOOTNOTES_ONLY}
                  onTaskListChange={
                    onTaskListChange &&
                    ((input) => {
                      const markerOffset = item.section.fileOffset(input.markerOffset);
                      if (markerOffset !== null) {
                        onTaskListChange({ markerOffset, checked: input.checked });
                      }
                    })
                  }
                />
              </div>
            );
          }
          if (item.chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS) {
            return (
              <div className="pb-5">
                {/* One block this long (a huge fence or HTML block) is too slow to parse. */}
                <pre className="mx-auto max-w-4xl overflow-x-auto px-6 font-mono text-xs whitespace-pre">
                  {item.chunk.text}
                </pre>
              </div>
            );
          }
          const prepared = prepareMarkdownChunk(
            item.chunk.text,
            item.index,
            props.definitions,
            props.footnotes,
          );
          const extensions =
            prepared.footnotesMode === "omit-seeded"
              ? CHUNK_FOOTNOTES_OMIT_SEEDED
              : prepared.footnotesMode === "omit"
                ? CHUNK_FOOTNOTES_OMIT
                : undefined;
          return (
            <div className="pb-5">
              <FileMarkdownPreview
                text={prepared.text}
                cwd={props.cwd}
                relativePath={props.relativePath}
                threadRef={props.threadRef}
                workspaceMutationId={props.workspaceMutationId}
                className="mx-auto max-w-4xl px-6"
                extensions={extensions}
                onTaskListChange={
                  onTaskListChange &&
                  ((input) =>
                    onTaskListChange({
                      markerOffset: item.start + input.markerOffset - prepared.offsetShift,
                      checked: input.checked,
                    }))
                }
              />
            </div>
          );
        }}
      />
    </div>
  );
}

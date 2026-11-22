import type { ScopedThreadRef } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { useState, type KeyboardEventHandler } from "react";

import { Spinner } from "~/components/ui/spinner";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  withMarkdownDefinitions,
} from "@t3tools/shared/markdownChunks";

// Browsers cap an element's height near 33.5M px, so the list holds only this many source lines
// (about 7M px at the size estimate); reaching either end moves the window like paging.
const WINDOW_MAX_LINES = 300_000;
const ESTIMATED_LINE_PX = 24;

function windowEnd(chunks: readonly MarkdownChunk[], base: number): number {
  let lines = 0;
  let index = base;
  while (
    index < chunks.length &&
    (index === base || lines + chunks[index]!.lines <= WINDOW_MAX_LINES)
  ) {
    lines += chunks[index]!.lines;
    index += 1;
  }
  return index;
}

/** Walks `direction` from `from` until half a window of lines has passed. */
function halfWindowFrom(chunks: readonly MarkdownChunk[], from: number, direction: 1 | -1): number {
  let lines = 0;
  let index = from;
  while (lines < WINDOW_MAX_LINES / 2) {
    const next = index + direction;
    if (next < 0 || next >= chunks.length) break;
    index = next;
    lines += chunks[index]!.lines;
  }
  return index;
}

interface ChunkItem {
  readonly index: number;
  readonly start: number;
  readonly chunk: MarkdownChunk;
}

/** Renders Markdown pieces in a virtualized list; task offsets are file offsets. */
export function ChunkedMarkdown(props: {
  readonly chunks: readonly MarkdownChunk[];
  /** Link definitions from the whole file, so references resolve across pieces. */
  readonly definitions: string;
  /** Shows a spinner after the last chunk while more of the file streams in. */
  readonly loading?: boolean;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const [base, setBase] = useState(0);
  const { chunks, onTaskListChange } = props;
  const end = windowEnd(chunks, base);
  const items: ChunkItem[] = [];
  let start = 0;
  let lines = 0;
  for (let index = 0; index < end; index += 1) {
    const chunk = chunks[index]!;
    if (index >= base) {
      items.push({ index, start, chunk });
      lines += chunk.lines;
    }
    start += chunk.text.length + 1;
  }
  const edge = (
    <div className="flex justify-center py-4">
      <Spinner size="md" tone="muted" />
    </div>
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={props.onKeyDown}
      onCopy={(event) => {
        // Select All only reaches rendered pieces; copying all of it copies the whole file.
        const list = event.currentTarget.firstElementChild;
        if (!list || !window.getSelection()?.containsNode(list)) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", chunks.map((chunk) => chunk.text).join("\n"));
      }}
    >
      <LegendList<ChunkItem>
        data={items}
        extraData={props.definitions}
        keyExtractor={(item) => String(item.index)}
        estimatedItemSize={(lines / Math.max(items.length, 1)) * ESTIMATED_LINE_PX}
        drawDistance={800}
        recycleItems={false}
        // Moving the window drops or adds pieces above the reader; keep what they see in place.
        maintainVisibleContentPosition
        onStartReached={() => {
          if (base > 0) setBase(halfWindowFrom(chunks, base, -1));
        }}
        onEndReached={() => {
          if (end < chunks.length) setBase(halfWindowFrom(chunks, base, 1));
        }}
        className="h-full scrollbar-gutter-both"
        contentContainerClassName="py-5"
        ListHeaderComponent={base > 0 ? edge : null}
        ListFooterComponent={end < chunks.length || props.loading ? edge : null}
        renderItem={({ item }) => (
          <div className="pb-5">
            {item.chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS ? (
              // One block this long (a huge fence or HTML block) is too slow to parse.
              <pre className="mx-auto max-w-4xl overflow-x-auto px-6 font-mono text-xs whitespace-pre">
                {item.chunk.text}
              </pre>
            ) : (
              <FileMarkdownPreview
                text={withMarkdownDefinitions(item.chunk.text, props.definitions)}
                cwd={props.cwd}
                relativePath={props.relativePath}
                threadRef={props.threadRef}
                workspaceMutationId={props.workspaceMutationId}
                className="mx-auto max-w-4xl px-6"
                onTaskListChange={
                  onTaskListChange &&
                  ((input) =>
                    onTaskListChange({
                      markerOffset: item.start + input.markerOffset,
                      checked: input.checked,
                    }))
                }
              />
            )}
          </div>
        )}
      />
    </div>
  );
}

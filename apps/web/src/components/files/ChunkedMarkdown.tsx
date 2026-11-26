import type { ScopedThreadRef } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useRef, type KeyboardEventHandler } from "react";

import { Spinner } from "~/components/ui/spinner";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  withMarkdownDefinitions,
} from "@t3tools/shared/markdownChunks";

const ESTIMATED_LINE_PX = 24;
const MAX_SAVED_POSITIONS = 100;

/** Reading positions outlive the preview, which unmounts when the file or thread changes. */
const savedPositions = new Map<string, { readonly index: number; readonly viewOffset: number }>();

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
  const { chunks, onTaskListChange } = props;
  const items: ChunkItem[] = [];
  let start = 0;
  let lines = 0;
  for (const [index, chunk] of chunks.entries()) {
    items.push({ index, start, chunk });
    lines += chunk.lines;
    start += chunk.text.length + 1;
  }
  const listRef = useRef<LegendListRef | null>(null);
  const positionKey = JSON.stringify([
    props.threadRef.environmentId,
    props.threadRef.threadId,
    props.cwd,
    props.relativePath,
  ]);
  const saved = savedPositions.get(positionKey);
  // The list applies its initial index once, so wait for the saved chunk to stream in.
  const awaitingSaved = props.loading && saved !== undefined && saved.index >= items.length;
  const spinner = (
    <div className="flex justify-center py-4">
      <Spinner size="md" tone="muted" />
    </div>
  );
  if (awaitingSaved) return spinner;
  return (
    <div
      // Clicking the text focuses the preview, so Select All stays inside it.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
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
          savedPositions.delete(positionKey);
          savedPositions.set(positionKey, {
            index: list.start,
            viewOffset: list.positionAtIndex(list.start) - list.scroll,
          });
          if (savedPositions.size > MAX_SAVED_POSITIONS) {
            savedPositions.delete(savedPositions.keys().next().value!);
          }
        }}
        extraData={props.definitions}
        keyExtractor={(item) => String(item.index)}
        estimatedItemSize={(lines / Math.max(items.length, 1)) * ESTIMATED_LINE_PX}
        drawDistance={800}
        recycleItems={false}
        className="h-full scrollbar-gutter-both"
        contentContainerClassName="py-5"
        ListFooterComponent={props.loading ? spinner : null}
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

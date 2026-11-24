import type { ScopedThreadRef } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import type { KeyboardEventHandler } from "react";

import { Spinner } from "~/components/ui/spinner";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  withMarkdownDefinitions,
} from "@t3tools/shared/markdownChunks";

const ESTIMATED_LINE_PX = 24;

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
        data={items}
        extraData={props.definitions}
        keyExtractor={(item) => String(item.index)}
        estimatedItemSize={(lines / Math.max(items.length, 1)) * ESTIMATED_LINE_PX}
        drawDistance={800}
        recycleItems={false}
        className="h-full scrollbar-gutter-both"
        contentContainerClassName="py-5"
        ListHeaderComponent={<div aria-hidden className="h-[var(--surface-top-inset,0px)]" />}
        ListFooterComponent={
          props.loading ? (
            <div className="flex justify-center py-4">
              <Spinner size="md" tone="muted" />
            </div>
          ) : null
        }
        renderItem={({ item }) => (
          <div className="pb-5">
            {item.chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS ? (
              // One block this long (a huge fence or HTML block) is too slow to parse.
              <pre className="mx-auto max-w-4xl overflow-x-auto px-6 font-mono text-meta whitespace-pre">
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

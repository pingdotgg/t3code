import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState, type KeyboardEventHandler } from "react";

import { Spinner } from "~/components/ui/spinner";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { LARGE_MARKDOWN_CHUNK_MAX_CHARS, type MarkdownChunk } from "@t3tools/shared/markdownChunks";

const viewportObservers = new WeakMap<Element, IntersectionObserver>();

// Chunks that stream in after the viewport mounted register themselves.
function observePlaceholder(placeholder: HTMLDivElement | null) {
  const viewport = placeholder?.closest("[data-chunk-viewport]");
  const observer = viewport ? viewportObservers.get(viewport) : undefined;
  if (!placeholder || !observer) return;
  observer.observe(placeholder);
  return () => observer.unobserve(placeholder);
}

/** Mounts each chunk once it scrolls near the viewport; task offsets are file offsets. */
export function ChunkedMarkdown(props: {
  readonly chunks: readonly MarkdownChunk[];
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
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([0]));
  const { chunks } = props;
  const observeViewport = (viewport: HTMLDivElement | null) => {
    if (!viewport) return;
    const next = new IntersectionObserver(
      (entries) => {
        const visible: number[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          next.unobserve(entry.target);
          visible.push(Number((entry.target as HTMLElement).dataset.chunk));
        }
        if (visible.length) setMounted((previous) => new Set([...previous, ...visible]));
      },
      { root: viewport, rootMargin: "150% 0px" },
    );
    viewportObservers.set(viewport, next);
    // Placeholders attach before the viewport does, so the first ones are picked up here.
    for (const placeholder of viewport.querySelectorAll("[data-chunk]")) next.observe(placeholder);
    return () => {
      next.disconnect();
      viewportObservers.delete(viewport);
    };
  };
  const starts: number[] = [];
  for (let index = 0; index < chunks.length; index += 1)
    starts.push(index === 0 ? 0 : starts[index - 1]! + chunks[index - 1]!.text.length + 1);
  return (
    <div
      ref={observeViewport}
      data-chunk-viewport
      onKeyDown={props.onKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto py-5 scrollbar-gutter-both"
    >
      {chunks.map((chunk, index) => (
        <ChunkSlot
          // oxlint-disable-next-line react/no-array-index-key -- chunks of one file never reorder
          key={index}
          index={index}
          chunk={chunk}
          start={starts[index]!}
          mounted={mounted.has(index)}
          cwd={props.cwd}
          relativePath={props.relativePath}
          threadRef={props.threadRef}
          workspaceMutationId={props.workspaceMutationId}
          onTaskListChange={props.onTaskListChange}
        />
      ))}
      {props.loading ? (
        <div className="flex shrink-0 justify-center py-4">
          <Spinner size="md" tone="muted" />
        </div>
      ) : null}
    </div>
  );
}

// Memoized so mounting one chunk does not re-render thousands of placeholders.
const ChunkSlot = memo(function ChunkSlot(props: {
  readonly index: number;
  readonly chunk: MarkdownChunk;
  readonly start: number;
  readonly mounted: boolean;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const { chunk, start, onTaskListChange } = props;
  if (!props.mounted)
    return (
      <div
        ref={observePlaceholder}
        data-chunk={props.index}
        className="shrink-0"
        style={{ height: `${chunk.lines * 1.5}rem` }}
      />
    );
  return (
    <div
      // Skips layout and paint for chunks scrolled away; `auto` remembers their real height.
      className="shrink-0 [content-visibility:auto]"
      style={{ containIntrinsicSize: `auto ${chunk.lines * 1.5}rem` }}
    >
      {chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS ? (
        // One block this long (a huge fence or HTML block) is too slow to parse.
        <pre className="mx-auto max-w-4xl overflow-x-auto px-6 font-mono text-xs whitespace-pre">
          {chunk.text}
        </pre>
      ) : (
        <FileMarkdownPreview
          text={chunk.text}
          cwd={props.cwd}
          relativePath={props.relativePath}
          threadRef={props.threadRef}
          workspaceMutationId={props.workspaceMutationId}
          className="mx-auto max-w-4xl px-6"
          onTaskListChange={
            onTaskListChange &&
            ((input) =>
              onTaskListChange({
                markerOffset: start + input.markerOffset,
                checked: input.checked,
              }))
          }
        />
      )}
    </div>
  );
});

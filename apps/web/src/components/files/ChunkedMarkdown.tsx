import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useLayoutEffect, useRef, useState, type KeyboardEventHandler } from "react";

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

// Browsers cap an element's height near 33.5M px, so only this many source lines (about 7M px
// at the placeholder estimate) are in the DOM at once; the edges move the window like paging.
const WINDOW_MAX_LINES = 300_000;

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
  const [base, setBase] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // The chunk the reader is looking at when the window moves, so it stays put on screen.
  const anchor = useRef<{ readonly index: number; readonly top: number } | null>(null);
  const { chunks } = props;
  const end = windowEnd(chunks, base);
  const observeViewport = (viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport;
    if (!viewport) return;
    const moveWindow = (nextBase: number) => {
      const top = viewport.getBoundingClientRect().top;
      for (const slot of viewport.querySelectorAll<HTMLElement>("[data-chunk-index]")) {
        const rect = slot.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        anchor.current = { index: Number(slot.dataset.chunkIndex), top: rect.top };
        break;
      }
      // Chunks far from the reader go back to placeholders so a later window starts cheap.
      const near = anchor.current?.index ?? nextBase;
      setBase(nextBase);
      setMounted(
        (previous) => new Set([...previous].filter((index) => Math.abs(index - near) <= 8)),
      );
    };
    const next = new IntersectionObserver(
      (entries) => {
        const visible: number[] = [];
        let nextBase: number | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          if (target.dataset.nextBase !== undefined) {
            nextBase = Number(target.dataset.nextBase);
            continue;
          }
          next.unobserve(target);
          visible.push(Number(target.dataset.chunk));
        }
        if (visible.length) setMounted((previous) => new Set([...previous, ...visible]));
        if (nextBase !== null) moveWindow(nextBase);
      },
      { root: viewport, rootMargin: "150% 0px" },
    );
    viewportObservers.set(viewport, next);
    // Placeholders attach before the viewport does, so the first ones are picked up here.
    for (const placeholder of viewport.querySelectorAll("[data-chunk], [data-next-base]"))
      next.observe(placeholder);
    return () => {
      next.disconnect();
      viewportObservers.delete(viewport);
    };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restores the reader's place in the scroll container after the chunk window moves, before paint.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const held = anchor.current;
    anchor.current = null;
    if (!viewport || !held) return;
    const slot = viewport.querySelector<HTMLElement>(`[data-chunk-index="${held.index}"]`);
    if (slot) viewport.scrollTop += slot.getBoundingClientRect().top - held.top;
    // Placeholders that were already in view report nothing new on their own; observe them afresh.
    const observer = viewportObservers.get(viewport);
    for (const placeholder of viewport.querySelectorAll("[data-chunk]")) {
      observer?.unobserve(placeholder);
      observer?.observe(placeholder);
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Runs after each window move, which is what changes `base`.
  }, [base]);
  const starts: number[] = [];
  for (let index = 0; index < chunks.length; index += 1)
    starts.push(index === 0 ? 0 : starts[index - 1]! + chunks[index - 1]!.text.length + 1);
  const visibleChunks = chunks.slice(base, end);
  return (
    <div
      ref={observeViewport}
      data-chunk-viewport
      onKeyDown={props.onKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto py-5 scrollbar-gutter-both [overflow-anchor:none]"
    >
      {base > 0 ? (
        <WindowEdge key={`start:${base}`} nextBase={halfWindowFrom(chunks, base, -1)} />
      ) : null}
      {visibleChunks.map((chunk, offset) => {
        const index = base + offset;
        return (
          <ChunkSlot
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
        );
      })}
      {end < chunks.length ? (
        <WindowEdge key={`end:${base}`} nextBase={halfWindowFrom(chunks, base, 1)} />
      ) : props.loading ? (
        <div className="flex shrink-0 justify-center py-4">
          <Spinner size="md" tone="muted" />
        </div>
      ) : null}
    </div>
  );
}

/** A loader at the window's edge; reaching it moves the window that way. */
function WindowEdge(props: { readonly nextBase: number }) {
  return (
    <div
      ref={observePlaceholder}
      data-next-base={props.nextBase}
      className="flex shrink-0 justify-center py-4"
    >
      <Spinner size="md" tone="muted" />
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
        data-chunk-index={props.index}
        className="shrink-0"
        style={{ height: `${chunk.lines * 1.5}rem` }}
      />
    );
  return (
    <div
      // Skips layout and paint for chunks scrolled away; `auto` remembers their real height.
      data-chunk-index={props.index}
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

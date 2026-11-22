import type { ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useState, type KeyboardEventHandler } from "react";

import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  splitLargeMarkdown,
} from "@t3tools/shared/markdownChunks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));

export interface LoadedMarkdown {
  readonly text: string;
  readonly chunks: MarkdownChunk[];
}

export function splitMarkdownForPreview(text: string): LoadedMarkdown {
  // Masking first keeps frontmatter longer than one chunk out of the rendered pieces.
  return { text, chunks: splitLargeMarkdown(maskMarkdownFrontmatter(text)) };
}

/** Mounts each chunk once it scrolls near the viewport; task offsets are file offsets. */
export function ChunkedMarkdown(props: {
  readonly file: LoadedMarkdown;
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
  const { chunks } = props.file;
  // Observes placeholders only; a mounted chunk drops its data-chunk and is never observed again.
  const observeChunks = (viewport: HTMLDivElement | null) => {
    if (!viewport) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible: number[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          visible.push(Number((entry.target as HTMLElement).dataset.chunk));
        }
        if (visible.length) setMounted((previous) => new Set([...previous, ...visible]));
      },
      { root: viewport, rootMargin: "150% 0px" },
    );
    for (const placeholder of viewport.querySelectorAll("[data-chunk]")) {
      observer.observe(placeholder);
    }
    return () => observer.disconnect();
  };

  if (chunks.some((chunk) => chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS))
    return (
      <Suspense fallback={<FileSurfaceLoading />}>
        <LargeTextViewer name={props.relativePath} text={props.file.text} delimiter={null} />
      </Suspense>
    );
  const starts: number[] = [];
  for (let index = 0; index < chunks.length; index += 1)
    starts.push(index === 0 ? 0 : starts[index - 1]! + chunks[index - 1]!.text.length + 1);
  return (
    <div
      ref={observeChunks}
      onKeyDown={props.onKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto py-5 scrollbar-gutter-both"
    >
      {chunks.map((chunk, index) => {
        const start = starts[index]!;
        const onTaskListChange = props.onTaskListChange;
        return mounted.has(index) ? (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- chunks of one file never reorder
            key={index}
            // Skips layout and paint for chunks scrolled away; `auto` remembers their real height.
            className="shrink-0 [content-visibility:auto]"
            style={{ containIntrinsicSize: `auto ${chunk.lines * 1.5}rem` }}
          >
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
          </div>
        ) : (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- chunks of one file never reorder
            key={index}
            data-chunk={index}
            className="shrink-0"
            style={{ height: `${chunk.lines * 1.5}rem` }}
          />
        );
      })}
    </div>
  );
}

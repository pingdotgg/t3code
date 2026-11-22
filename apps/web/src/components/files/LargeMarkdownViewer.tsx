import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useImperativeHandle, useState, type RefObject } from "react";

import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  LARGE_MARKDOWN_CHUNK_MAX_CHARS,
  type MarkdownChunk,
  splitLargeMarkdown,
} from "@t3tools/shared/markdownChunks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import LargeTextViewer from "./LargeTextViewer";

/** Renders a whole Markdown file, parsing each chunk only once it scrolls near the viewport. */
export default function LargeMarkdownViewer(props: {
  readonly src: string;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const [file, setFile] = useState<{ text: string; chunks: MarkdownChunk[] } | "failed" | null>(
    null,
  );
  const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([0]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file fetch and cancels it when the source changes or the preview closes.
  useEffect(() => {
    const controller = new AbortController();
    fetch(props.src, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      // Masking first keeps frontmatter longer than one chunk out of the rendered pieces.
      .then((text) => setFile({ text, chunks: splitLargeMarkdown(maskMarkdownFrontmatter(text)) }))
      .catch(() => {
        if (!controller.signal.aborted) setFile("failed");
      });
    return () => controller.abort();
  }, [props.src]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      file && file !== "failed"
        ? Promise.resolve(file.text)
        : Promise.reject(new Error(gt("The file could not be loaded. Try again."))),
    [file, gt],
  );
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

  if (file === "failed")
    return (
      <FileSurfaceFailure
        message={gt("The file could not be loaded. Try again.")}
        onRetry={props.onRetry}
      />
    );
  if (file === null) return <FileSurfaceLoading />;
  if (file.chunks.some((chunk) => chunk.text.length > LARGE_MARKDOWN_CHUNK_MAX_CHARS))
    return <LargeTextViewer name={props.relativePath} text={file.text} delimiter={null} />;
  return (
    <div
      ref={observeChunks}
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto py-5 scrollbar-gutter-both"
    >
      {file.chunks.map((chunk, index) =>
        mounted.has(index) ? (
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
        ),
      )}
    </div>
  );
}

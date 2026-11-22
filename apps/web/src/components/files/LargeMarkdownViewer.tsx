import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useImperativeHandle, useState, type RefObject } from "react";

import { ChunkedMarkdown } from "./ChunkedMarkdown";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { createMarkdownSplitter, type MarkdownChunk } from "@t3tools/shared/markdownChunks";

interface StreamedMarkdown {
  readonly chunks: readonly MarkdownChunk[];
  readonly done: boolean;
}

// Switching back to a recently opened file reuses its pieces instead of downloading it again.
const RECENT_FILES = 4;
const RECENT_FILE_MAX_CHARS = 16 * 1024 * 1024;
const recentFiles = new Map<string, readonly MarkdownChunk[]>();
// New pieces render in batches; a re-render per network read would repaint every placeholder.
const PUBLISH_INTERVAL_MS = 200;

function rememberFile(src: string, chunks: readonly MarkdownChunk[]) {
  if (chunks.reduce((chars, chunk) => chars + chunk.text.length, 0) > RECENT_FILE_MAX_CHARS) return;
  recentFiles.delete(src);
  recentFiles.set(src, chunks);
  if (recentFiles.size > RECENT_FILES) recentFiles.delete(recentFiles.keys().next().value!);
}

/** Renders a whole Markdown file as it downloads, parsing each piece only near the viewport. */
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
  const [file, setFile] = useState<StreamedMarkdown | "failed" | null>(() => {
    const cached = recentFiles.get(props.src);
    return cached ? { chunks: cached, done: true } : null;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the streamed download and cancels it when the source changes or the preview closes.
  useEffect(() => {
    if (recentFiles.has(props.src)) return;
    const controller = new AbortController();
    const splitter = createMarkdownSplitter();
    const chunks: MarkdownChunk[] = [];
    let published = 0;
    const publish = (done: boolean) => {
      if (!done && chunks.length === published) return;
      published = chunks.length;
      setFile({ chunks: [...chunks], done });
    };
    void (async () => {
      const response = await fetch(props.src, { cache: "no-store", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let lastPublish = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(...splitter.push(value));
        if (published === 0 || performance.now() - lastPublish > PUBLISH_INTERVAL_MS) {
          publish(false);
          lastPublish = performance.now();
        }
      }
      chunks.push(...splitter.end());
      rememberFile(props.src, chunks);
      publish(true);
    })().catch(() => {
      if (!controller.signal.aborted) setFile("failed");
    });
    return () => controller.abort();
  }, [props.src]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      file && file !== "failed" && file.done
        ? Promise.resolve(file.chunks.map((chunk) => chunk.text).join("\n"))
        : Promise.reject(
            new Error(
              file === "failed"
                ? gt("The file could not be loaded. Try again.")
                : gt("The file is still loading. Try again in a moment."),
            ),
          ),
    [file, gt],
  );

  if (file === "failed")
    return (
      <FileSurfaceFailure
        message={gt("The file could not be loaded. Try again.")}
        onRetry={props.onRetry}
      />
    );
  if (file === null) return <FileSurfaceLoading />;
  return (
    <ChunkedMarkdown
      chunks={file.chunks}
      loading={!file.done}
      cwd={props.cwd}
      relativePath={props.relativePath}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
    />
  );
}

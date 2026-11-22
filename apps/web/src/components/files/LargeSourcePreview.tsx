import type { FileOptions } from "@pierre/diffs/react";
import { useGT } from "gt-react";
import { lazy, Suspense, useEffect, useImperativeHandle, useState, type RefObject } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";
import { RENDERED_MAX_LINES } from "./largeTextProtocol";
import SourceFilePreview from "./ReadOnlySourcePreview";

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));

// Switching back to a recently opened file reuses its text instead of downloading it again.
const RECENT_FILES = 4;
const RECENT_FILE_MAX_CHARS = 16 * 1024 * 1024;
const recentFiles = new Map<string, string>();

function rememberFile(src: string, text: string) {
  if (text.length > RECENT_FILE_MAX_CHARS) return;
  recentFiles.delete(src);
  recentFiles.set(src, text);
  if (recentFiles.size > RECENT_FILES) recentFiles.delete(recentFiles.keys().next().value!);
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

/**
 * Shows a file past the 1 MB read with syntax highlighting, starting from the prefix already
 * read; files too tall for the browser to lay out stay in the plain virtualized viewer.
 */
export default function LargeSourcePreview(props: {
  readonly src: string;
  readonly name: string;
  /** The first megabyte, shown until the whole file arrives. */
  readonly preview: string;
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly onRetry: () => void;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
}) {
  const gt = useGT();
  const [text, setText] = useState<string | "too-tall" | "failed" | null>(
    () => recentFiles.get(props.src) ?? null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file download and cancels it when the source changes or the preview closes.
  useEffect(() => {
    if (recentFiles.has(props.src)) return;
    const controller = new AbortController();
    fetch(props.src, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((full) => {
        if (countLines(full) > RENDERED_MAX_LINES) {
          setText("too-tall");
          return;
        }
        rememberFile(props.src, full);
        setText(full);
      })
      .catch(() => {
        if (!controller.signal.aborted) setText("failed");
      });
    return () => controller.abort();
  }, [props.src]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      typeof text === "string" && text !== "too-tall" && text !== "failed"
        ? Promise.resolve(text)
        : Promise.reject(new Error(gt("The file is still loading. Try again in a moment."))),
    [text, gt],
  );

  if (text === "too-tall" || text === "failed")
    return (
      <Suspense fallback={<FileSurfaceLoading />}>
        <LargeTextViewer
          name={props.name}
          src={props.src}
          copyContents={props.copyContents}
          onRetry={props.onRetry}
          delimiter={null}
          revealLine={props.revealLine}
          revealRequestId={props.revealRequestId}
          wordWrap={props.wordWrap}
        />
      </Suspense>
    );
  return (
    <SourceFilePreview
      name={props.name}
      text={text ?? props.preview}
      onPostRender={props.onPostRender}
      wordWrap={props.wordWrap}
    />
  );
}

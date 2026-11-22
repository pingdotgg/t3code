import type { FileOptions } from "@pierre/diffs/react";
import { useGT } from "gt-react";
import { lazy, Suspense, useEffect, useImperativeHandle, useState, type RefObject } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";
import { downloadRest } from "./largeSourceDownload";
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

/**
 * Shows a file past the 1 MB read with syntax highlighting, starting from the prefix already
 * read; files too tall for the browser to lay out stay in the plain virtualized viewer.
 */
export default function LargeSourcePreview(props: {
  readonly src: string;
  readonly name: string;
  /** The first megabyte, shown until the whole file arrives. */
  readonly preview: string;
  readonly sizeBytes: number;
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly onRetry: () => void;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
}) {
  const gt = useGT();
  const [file, setFile] = useState<
    { readonly text: string; readonly done: boolean } | "too-tall" | "failed" | null
  >(() => {
    const cached = recentFiles.get(props.src);
    return cached === undefined ? null : { text: cached, done: true };
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file download and cancels it when the source changes or the preview closes.
  useEffect(() => {
    if (recentFiles.has(props.src)) return;
    const controller = new AbortController();
    downloadRest({
      src: props.src,
      preview: props.preview,
      sizeBytes: props.sizeBytes,
      signal: controller.signal,
      onProgress: (text) => setFile({ text, done: false }),
    })
      .then((result) => {
        if (result === "too-tall") {
          setFile("too-tall");
          return;
        }
        rememberFile(props.src, result);
        setFile({ text: result, done: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFile("failed");
      });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The preview and size belong to this source; a new revision gets a new source.
  }, [props.src]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      typeof file === "object" && file?.done
        ? Promise.resolve(file.text)
        : Promise.reject(new Error(gt("The file is still loading. Try again in a moment."))),
    [file, gt],
  );

  if (file === "too-tall" || file === "failed")
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
      text={file?.text ?? props.preview}
      onPostRender={props.onPostRender}
      wordWrap={props.wordWrap}
    />
  );
}

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useImperativeHandle, useState, type RefObject } from "react";

import { ChunkedMarkdown, type LoadedMarkdown, splitMarkdownForPreview } from "./ChunkedMarkdown";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

// Switching back to a recently opened file reuses its text instead of downloading it again.
const RECENT_FILES = 4;
const recentFiles = new Map<string, LoadedMarkdown>();

function rememberFile(src: string, file: LoadedMarkdown) {
  recentFiles.delete(src);
  recentFiles.set(src, file);
  if (recentFiles.size > RECENT_FILES) recentFiles.delete(recentFiles.keys().next().value!);
}

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
  const [file, setFile] = useState<LoadedMarkdown | "failed" | null>(
    () => recentFiles.get(props.src) ?? null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file fetch and cancels it when the source changes or the preview closes.
  useEffect(() => {
    if (recentFiles.has(props.src)) return;
    const controller = new AbortController();
    fetch(props.src, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => {
        const loaded = splitMarkdownForPreview(text);
        rememberFile(props.src, loaded);
        setFile(loaded);
      })
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
      file={file}
      cwd={props.cwd}
      relativePath={props.relativePath}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
    />
  );
}

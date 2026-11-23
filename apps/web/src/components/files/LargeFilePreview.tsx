import type { ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_TOKENIZE_MAX_LENGTH } from "@pierre/diffs";
import type { FileOptions } from "@pierre/diffs/react";
import { useGT } from "gt-react";
import { lazy, Suspense, useImperativeHandle, type RefObject } from "react";

import { ChunkedMarkdown } from "./ChunkedMarkdown";
import { FileSurfaceLoading } from "./fileSurfaceChrome";
import { useFullFileMarkdown, useFullFileText } from "./fullFileText";
import { FULL_TEXT_MAX_BYTES } from "./largeTextProtocol";
import SourceFilePreview from "./ReadOnlySourcePreview";

const LargeTextViewer = lazy(() => import("./LargeTextViewer"));

/**
 * A file past the 1 MB read, shown like any other file once its full text arrives. Tables, and
 * files too large to hold or lay out, use the worker-backed plain viewer.
 */
export default function LargeFilePreview(props: {
  readonly src: string;
  readonly name: string;
  /** The first megabyte already read. */
  readonly preview: string;
  readonly sizeBytes: number;
  readonly delimiter: "," | "\t" | null;
  /** Renders the file as Markdown resolving links against this workspace; null shows source. */
  readonly markdownCwd: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly onRetry: () => void;
  readonly onPostRender?: FileOptions<unknown, undefined>["onPostRender"];
  readonly revealLine: number | null;
  readonly revealRequestId: number;
  readonly wordWrap: boolean;
}) {
  const plain = props.delimiter !== null || props.sizeBytes > FULL_TEXT_MAX_BYTES;
  return plain ? <PlainViewer {...props} /> : <FullTextPreview {...props} />;
}

// Pierre keeps every token of a highlighted file in memory: a 320k-line log took about 280 MB.
const HIGHLIGHT_MAX_LINES = DEFAULT_TOKENIZE_MAX_LENGTH;

/** Estimates the whole file's lines from the preview, so highlighting is decided once. */
function estimatedLines(preview: string, sizeBytes: number): number {
  let lines = 1;
  for (let index = preview.indexOf("\n"); index !== -1; index = preview.indexOf("\n", index + 1))
    lines += 1;
  return (lines / Math.max(1, new TextEncoder().encode(preview).length)) * sizeBytes;
}

function FullTextPreview(props: Parameters<typeof LargeFilePreview>[0]) {
  const file = useFullFileText(props.src, props.preview);
  // Deciding from the full text would highlight the preview, then drop it once the file arrives.
  const highlight = estimatedLines(props.preview, props.sizeBytes) <= HIGHLIGHT_MAX_LINES;
  if (file === "too-large" || file === "failed") return <PlainViewer {...props} />;
  return (
    <>
      <CopyText copyContents={props.copyContents} text={file.done ? file.text : null} />
      {props.markdownCwd !== null ? (
        <MarkdownText {...props} markdownCwd={props.markdownCwd} file={file} />
      ) : (
        <SourceFilePreview
          name={props.name}
          text={file.text}
          onPostRender={props.onPostRender}
          wordWrap={props.wordWrap}
          tokenizeMaxLength={highlight ? Number.POSITIVE_INFINITY : 0}
        />
      )}
    </>
  );
}

function MarkdownText(
  props: Parameters<typeof LargeFilePreview>[0] & {
    readonly markdownCwd: string;
    readonly file: { readonly text: string; readonly done: boolean };
  },
) {
  return (
    <ChunkedMarkdown
      {...useFullFileMarkdown(props.src, props.file.text)}
      loading={!props.file.done}
      cwd={props.markdownCwd}
      relativePath={props.name}
      threadRef={props.threadRef}
      workspaceMutationId={props.workspaceMutationId}
    />
  );
}

function CopyText(props: {
  readonly copyContents: RefObject<(() => Promise<string>) | null>;
  readonly text: string | null;
}) {
  const gt = useGT();
  const { text } = props;
  useImperativeHandle(
    props.copyContents,
    () => () =>
      text === null
        ? Promise.reject(new Error(gt("The file is still loading. Try again in a moment.")))
        : Promise.resolve(text),
    [text, gt],
  );
  return null;
}

function PlainViewer(props: Parameters<typeof LargeFilePreview>[0]) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <LargeTextViewer
        name={props.name}
        src={props.src}
        copyContents={props.copyContents}
        onRetry={props.onRetry}
        delimiter={props.delimiter}
        revealLine={props.revealLine}
        revealRequestId={props.revealRequestId}
        wordWrap={props.wordWrap}
      />
    </Suspense>
  );
}

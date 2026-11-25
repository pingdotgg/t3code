import type { ScopedThreadRef } from "@lathe/contracts";
import { Fragment, useEffect, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  advanceDocumentSections,
  splitMarkdownDocument,
  type MarkdownDocumentSection,
} from "~/markdown-document";
import { resolvePathLinkTarget } from "@lathe/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@lathe/shared/markdownFrontmatter";

type TaskListChange = (input: { readonly markerOffset: number; readonly checked: boolean }) => void;

/**
 * The sections on screen, catching up with `sections` one per task. A long
 * file parses in pieces between frames instead of holding the page for its
 * whole parse, and an edit re-renders only the sections it changed.
 */
function useShownSections(
  sections: ReadonlyArray<MarkdownDocumentSection>,
): ReadonlyArray<MarkdownDocumentSection> {
  const [shown, setShown] = useState<ReadonlyArray<MarkdownDocumentSection>>(() =>
    sections.slice(0, 1),
  );
  const next = advanceDocumentSections(shown, sections);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- schedules the next section on a timer so a long file parses between frames
  useEffect(() => {
    if (next === shown) return;
    const timeout = setTimeout(() => setShown(next));
    return () => clearTimeout(timeout);
  }, [next, shown]);
  return shown;
}

/** A markdown file read as a document. A long one fills in section by section. */
export function MarkdownDocument(props: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly imageBaseDir?: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  /** Replaces the page's own width and padding, as for one piece of a chunked file. */
  readonly className?: string | undefined;
  readonly onTaskListChange?: TaskListChange | undefined;
}) {
  const text = maskMarkdownFrontmatter(props.text);
  const layoutClassName = props.className ?? "mx-auto max-w-4xl px-8 py-7";
  const sections = splitMarkdownDocument(text);
  const shownSections = useShownSections(sections);
  // Callers pass a fresh callback each render; a stable one keeps the
  // memoized markdown from re-parsing whenever the surface around it updates.
  const stableTaskListChange = useStableCallback((input: Parameters<TaskListChange>[0]) =>
    props.onTaskListChange?.(input),
  );
  const onTaskListChange = props.onTaskListChange ? stableTaskListChange : undefined;

  if (sections.length === 1) {
    return (
      <ChatMarkdown
        text={text}
        cwd={props.cwd}
        imageBaseDir={props.imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        asDocument
        className={`chat-markdown-document ${layoutClassName}`}
        onTaskListChange={onTaskListChange}
      />
    );
  }
  return (
    <div className={layoutClassName}>
      {shownSections.map((section, index) => (
        // Sections are joined by the newline a whole render puts between
        // blocks, so text offsets for comments match either way. A section
        // is replaced in place when its text moves, so position is its key.
        // oxlint-disable-next-line react/no-array-index-key
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <ChatMarkdown
            text={section.text}
            documentSection={section}
            cwd={props.cwd}
            imageBaseDir={props.imageBaseDir}
            threadRef={props.threadRef}
            workspaceMutationId={props.workspaceMutationId}
            asDocument
            className="chat-markdown-document chat-markdown-section"
            onTaskListChange={onTaskListChange}
          />
        </Fragment>
      ))}
    </div>
  );
}

export function FileMarkdownPreview(props: {
  readonly sourceRef?: ((element: HTMLDivElement | null) => void) | undefined;
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly className?: string;
  readonly onTaskListChange?: TaskListChange | undefined;
}) {
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator + 1), props.cwd)
      : props.cwd;

  const { sourceRef: bindSource } = props;
  // The citation source attributes let a selection here become a document quote.
  return (
    <div
      ref={bindSource}
      data-document-citation-source={props.relativePath}
      data-document-citation-environment={props.threadRef.environmentId}
      data-document-citation-thread={props.threadRef.threadId}
    >
      <MarkdownDocument
        text={props.text}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        className={props.className}
        onTaskListChange={props.onTaskListChange}
      />
    </div>
  );
}

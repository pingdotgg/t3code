import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareQuote } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { resolvePathLinkTarget } from "~/terminal-links";

import { MARKDOWN_SOURCE_LINE_PLUGINS, resolveSelectionSourceLines } from "./markdownSourceLines";

/** Height of the action plus the gap that keeps it clear of the selection. */
const QUOTE_ACTION_OFFSET = 42;

interface QuoteAction {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly top: number;
  readonly left: number;
}

export interface FileMarkdownPreviewProps {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}

export function FileMarkdownPreview(props: FileMarkdownPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const [quoteAction, setQuoteAction] = useState<QuoteAction | null>(null);

  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;

  const composerDraftTarget = props.composerDraftTarget;

  // Reading the selection covers every way to make one: dragging, shift+arrows,
  // and a touch handle. Quoting needs the lines the selection came from, so a
  // selection the preview cannot place offers no action rather than a wrong one.
  useEffect(() => {
    if (!composerDraftTarget) {
      setQuoteAction(null);
      return;
    }

    let frame: number | null = null;
    const readSelection = () => {
      frame = null;
      const container = containerRef.current;
      const selection = window.getSelection();
      if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setQuoteAction(null);
        return;
      }

      const text = selection.toString().trim();
      const range = selection.getRangeAt(0);
      if (!text || !container.contains(range.commonAncestorContainer)) {
        setQuoteAction(null);
        return;
      }

      const lines = resolveSelectionSourceLines(range, container);
      if (!lines) {
        setQuoteAction(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setQuoteAction({
        text,
        startLine: lines.startLine,
        endLine: lines.endLine,
        top: Math.max(0, rect.top - containerRect.top - QUOTE_ACTION_OFFSET),
        left: rect.left - containerRect.left + rect.width / 2,
      });
    };

    const handleSelectionChange = () => {
      // A drag fires this per pointer move; one read per frame is enough.
      if (frame === null) frame = requestAnimationFrame(readSelection);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [composerDraftTarget]);

  // Lines were resolved against the text on screen. If the file changes under
  // the selection — an agent writing to it, a checkbox toggled — they no longer
  // describe it, so the action starts over with the next selection.
  useEffect(() => {
    setQuoteAction(null);
  }, [props.text]);

  const handleQuoteInChat = useCallback(() => {
    if (!quoteAction || !composerDraftTarget) return;

    addReviewComment(
      composerDraftTarget,
      buildFileReviewComment({
        id: randomUUID(),
        filePath: props.relativePath,
        startLine: quoteAction.startLine,
        endLine: quoteAction.endLine,
        text: quoteAction.text,
        contents: props.text,
      }),
    );

    setQuoteAction(null);
    window.getSelection()?.removeAllRanges();
  }, [addReviewComment, composerDraftTarget, props.relativePath, props.text, quoteAction]);

  return (
    <div ref={containerRef} className="relative min-h-full w-full">
      {quoteAction ? (
        <div
          style={{ transform: `translate3d(${quoteAction.left}px, ${quoteAction.top}px, 0)` }}
          className="absolute top-0 left-0 z-20"
        >
          <div className="-translate-x-1/2">
            <Button
              size="xs"
              variant="secondary"
              className="rounded-full shadow-lg"
              onMouseDown={(event) => {
                // Keep the selection alive through the click that quotes it.
                event.preventDefault();
              }}
              onClick={handleQuoteInChat}
            >
              <MessageSquareQuote />
              Quote in chat
            </Button>
          </div>
        </div>
      ) : null}

      <ChatMarkdown
        text={props.text}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        className="mx-auto max-w-4xl px-6 py-5"
        extraRemarkPlugins={MARKDOWN_SOURCE_LINE_PLUGINS}
        onTaskListChange={props.onTaskListChange}
      />
    </div>
  );
}

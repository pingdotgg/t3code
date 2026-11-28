import {
  cloneFileDiffMetadata,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useState } from "react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";
import {
  getReviewPositionAnchor,
  PendingReviewCommentCard,
  toViewerSide,
} from "../PullRequestReviewAnnotation";
import type { PendingReviewComment } from "../pullRequestReviewStore";
import {
  commentDraftFor,
  GuideCommentDraft,
  type CommentDraft,
  type ExcerptCommenting,
} from "./GuideExcerpt";

interface FileAnnotation {
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
}

export function GuideFileDiff({
  path,
  file,
  commenting,
  loadDiffFiles,
}: {
  path: string;
  file: FileDiffMetadata;
  commenting: ExcerptCommenting | null;
  loadDiffFiles: FileDiffContentsLoader;
}) {
  const resolvedTheme = useRenderedAppearance();
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  // Loading the unchanged lines rewrites the diff it is given; the excerpts read the same file
  // as a patch, so this view expands a copy of its own.
  const expandable = cloneFileDiffMetadata(file);

  const annotations = (() => {
    const groups = new Map<string, DiffLineAnnotation<FileAnnotation>>();
    const update = (
      side: "additions" | "deletions",
      line: number,
      change: (metadata: FileAnnotation) => FileAnnotation,
    ) => {
      const key = `${side}:${line}`;
      const group = groups.get(key) ?? {
        side,
        lineNumber: line,
        metadata: { pending: [], draft: false },
      };
      groups.set(key, { ...group, metadata: change(group.metadata) });
    };
    for (const comment of commenting?.pending ?? []) {
      if (comment.path !== path) continue;
      const anchor = getReviewPositionAnchor(comment.position);
      update(toViewerSide(anchor.side), anchor.line, (metadata) => ({
        ...metadata,
        pending: [...metadata.pending, comment],
      }));
    }
    if (draft !== null) {
      const anchor = getReviewPositionAnchor(draft.position);
      update(toViewerSide(anchor.side), anchor.line, (metadata) => ({ ...metadata, draft: true }));
    }
    return [...groups.values()];
  })();

  const beginComment = (range: SelectedLineRange | null) => {
    const next = commentDraftFor(file, range, commenting);
    if (next !== null) setDraft(next);
  };
  const interactive = commenting !== null && draft === null;

  const options = {
    diffStyle: "unified" as const,
    lineDiffType: "none" as const,
    overflow: "scroll" as const,
    disableFileHeader: true,
    theme: resolveDiffThemeName(resolvedTheme),
    themeType: resolvedTheme,
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
    enableGutterUtility: interactive,
    enableLineSelection: interactive,
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
    loadDiffFiles,
  };
  return (
    <div className="border-t border-border/60">
      <FileDiff<FileAnnotation>
        fileDiff={expandable}
        options={options}
        lineAnnotations={annotations}
        selectedLines={draft?.range ?? null}
        renderAnnotation={(annotation) => (
          <div className="font-sans">
            {annotation.metadata.pending.map((comment) => (
              <PendingReviewCommentCard
                key={comment.id}
                comment={comment}
                onRemove={() => commenting?.onRemove(comment.id)}
              />
            ))}
            {annotation.metadata.draft && draft !== null && commenting !== null ? (
              <GuideCommentDraft
                path={path}
                file={file}
                draft={draft}
                commenting={commenting}
                onClose={() => setDraft(null)}
              />
            ) : null}
          </div>
        )}
      />
    </div>
  );
}

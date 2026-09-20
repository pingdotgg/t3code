import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo, useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32 } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { usePullRequestReviewStore } from "../pullRequest/pullRequestReviewStore";
import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  codeViewKey,
  files,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const draftKey = JSON.stringify(["thread-diff", composerDraftTarget, sectionId]);
  const retainedDraft = usePullRequestReviewStore((store) => store.inlineDrafts[draftKey]);
  const setRetainedDraft = usePullRequestReviewStore((store) => store.setInlineDraft);
  const draft = useMemo(
    () =>
      retainedDraft
        ? {
            fileKey: retainedDraft.fileKey,
            annotation: {
              side: annotationSide(retainedDraft.range),
              lineNumber: retainedDraft.range.end,
              metadata: {
                entries: [
                  {
                    id: retainedDraft.comment.id,
                    kind: "draft" as const,
                    range: retainedDraft.range,
                    rangeLabel: retainedDraft.comment.rangeLabel,
                    text: "",
                  },
                ],
              },
            },
          }
        : null,
    [retainedDraft?.fileKey, retainedDraft?.range, retainedDraft?.comment],
  );
  const draftText = retainedDraft?.text ?? "";
  const setDraftText = useCallback(
    (text: string) => {
      const current = usePullRequestReviewStore.getState().inlineDrafts[draftKey];
      if (current) setRetainedDraft(draftKey, { ...current, text });
    },
    [draftKey, setRetainedDraft],
  );

  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);
  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
        const persisted = reviewComments
          .filter(
            (comment) =>
              comment.sectionId === sectionId &&
              comment.filePath === filePath &&
              (comment.fenceLanguage ?? "diff") === "diff",
          )
          .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
            const range = restoreDiffReviewCommentRange(fileDiff, comment);
            if (!range) return annotations;
            return appendAnnotationEntry(annotations, range, {
              id: comment.id,
              kind: "comment",
              range,
              rangeLabel: comment.rangeLabel,
              text: comment.text,
            });
          }, []);
        const annotations =
          draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
        return {
          id: fileKey,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          version: fnv1a32(
            `${fileVersion}:${collapsed ? "1" : "0"}:${annotations
              .flatMap((annotation) =>
                annotation.metadata.entries.map(
                  (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
                ),
              )
              .join(":")}`,
          ),
        };
      }),
    [draft, files, reviewComments, sectionId],
  );

  const removeEntry = useCallback(
    (entryId: string) => {
      setSelectedLines(null);
      if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
        setRetainedDraft(draftKey, null);
      } else {
        removeReviewComment(composerDraftTarget, entryId);
      }
    },
    [composerDraftTarget, draft, draftKey, removeReviewComment, setRetainedDraft],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draft?.annotation.metadata.entries.find(
        (candidate) => candidate.id === entryId,
      );
      if (!entry) return;
      if (!retainedDraft) return;
      // Preserve the original selection even if the live diff changes while editing.
      const comment = { ...retainedDraft.comment, text };
      addReviewComment(composerDraftTarget, comment);
      const added = useComposerDraftStore
        .getState()
        .getComposerDraft(composerDraftTarget)
        ?.reviewComments.some((current) => current.id === comment.id);
      if (!added) return;
      setSelectedLines(null);
      setRetainedDraft(draftKey, null);
    },
    [addReviewComment, composerDraftTarget, draft, draftKey, retainedDraft, setRetainedDraft],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = filesByKey.get(item.id);
      if (!file) return;
      const id = nextFileCommentId();
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range,
        text: "",
      });
      if (!comment) return;
      if (retainedDraft) return;
      setRetainedDraft(draftKey, { fileKey: item.id, range, comment, text: "" });
    },
    [draftKey, filesByKey, retainedDraft, sectionId, sectionTitle, setRetainedDraft],
  );

  const hasOpenComment = draft !== null;
  return (
    <>
      {retainedDraft && !filesByKey.has(retainedDraft.fileKey) ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Draft for {retainedDraft.comment.filePath}. The original selection is retained with your
            comment.
          </p>
          <DiffCommentAnnotation
            kind="draft"
            rangeLabel={retainedDraft.comment.rangeLabel}
            text={draftText}
            onTextChange={setDraftText}
            onCancel={() => removeEntry(retainedDraft.comment.id)}
            onComment={(text) => submitEntry(retainedDraft.comment.id, text)}
          />
        </div>
      ) : null}
      <StyledDiffCodeView<DiffCommentAnnotationGroup>
        key={codeViewKey}
        {...(viewerRef ? { viewerRef } : {})}
        {...(className ? { className } : {})}
        {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
        {...(renderHeaderMetadata
          ? {
              renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
                item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
            }
          : {})}
        {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
        items={items}
        selectedLines={selectedLines}
        onSelectedLinesChange={setSelectedLines}
        options={{
          ...options,
          enableGutterUtility: !hasOpenComment,
          enableLineSelection: !hasOpenComment,
          onGutterUtilityClick: beginComment,
        }}
        renderHeaderFilenameSuffix={(item) =>
          item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
        }
        renderHeaderPrefix={(item) =>
          item.type === "diff"
            ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
            : null
        }
        renderAnnotation={(annotation) => {
          const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
          return (
            <div
              className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
            >
              {annotation.metadata.entries.map((entry) => (
                <DiffCommentAnnotation
                  key={entry.id}
                  kind={entry.kind}
                  rangeLabel={entry.rangeLabel}
                  text={entry.kind === "draft" ? draftText : entry.text}
                  onTextChange={setDraftText}
                  onCancel={() => removeEntry(entry.id)}
                  onComment={(text) => submitEntry(entry.id, text)}
                  onDelete={() => removeEntry(entry.id)}
                />
              ))}
            </div>
          );
        }}
      />
    </>
  );
}

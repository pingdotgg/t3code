import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { LocalCommentAnnotation } from "../files/LocalCommentAnnotation";
import { nextFileCommentId } from "../files/fileCommentAnnotations";

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

interface AnnotatableFileDiffProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: FileDiffProps<DiffCommentAnnotationGroup>["options"];
  renderHeaderPrefix: (fileDiff: FileDiffMetadata) => ReactNode;
}

export function AnnotatableFileDiff({
  fileDiff,
  filePath,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  renderHeaderPrefix,
}: AnnotatableFileDiffProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(null);
  const [draftAnnotation, setDraftAnnotation] = useState<DiffCommentLineAnnotation | null>(null);
  const persistedAnnotations = useMemo(
    () =>
      reviewComments
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
        }, []),
    [fileDiff, filePath, reviewComments, sectionId],
  );
  const lineAnnotations = useMemo(
    () => (draftAnnotation ? [...persistedAnnotations, draftAnnotation] : persistedAnnotations),
    [draftAnnotation, persistedAnnotations],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      if (
        draftAnnotation?.metadata.entries.some(
          (entry) => entry.id === entryId && entry.kind === "draft",
        )
      ) {
        setDraftAnnotation(null);
        return;
      }
      removeReviewComment(composerDraftTarget, entryId);
    },
    [composerDraftTarget, draftAnnotation, removeReviewComment],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draftAnnotation?.metadata.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;

      const comment = buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath,
        fileDiff,
        range: entry.range,
        text,
      });
      if (comment) {
        addReviewComment(composerDraftTarget, comment);
      }
      setSelectedRange(null);
      setDraftAnnotation(null);
    },
    [
      addReviewComment,
      composerDraftTarget,
      fileDiff,
      filePath,
      draftAnnotation,
      sectionId,
      sectionTitle,
    ],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange) => {
      const id = nextFileCommentId();
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath,
        fileDiff,
        range,
        text: "",
      });
      if (!comment) return;

      const draftEntry: DiffCommentAnnotationEntry = {
        id,
        kind: "draft",
        range,
        rangeLabel: comment.rangeLabel,
        text: "",
      };
      setDraftAnnotation({
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: { entries: [draftEntry] },
      });
    },
    [fileDiff, filePath, sectionId, sectionTitle],
  );

  const hasOpenCommentForm = draftAnnotation !== null;
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) beginComment(range);
    },
    [beginComment],
  );

  return (
    <FileDiff<DiffCommentAnnotationGroup>
      fileDiff={fileDiff}
      renderHeaderPrefix={renderHeaderPrefix}
      options={{
        ...options,
        enableGutterUtility: !hasOpenCommentForm,
        enableLineSelection: !hasOpenCommentForm,
        onGutterUtilityClick: setSelectedRange,
        onLineSelectionChange: setSelectedRange,
        onLineSelectionEnd: handleLineSelectionEnd,
      }}
      selectedLines={selectedRange}
      lineAnnotations={lineAnnotations}
      renderAnnotation={(annotation) => (
        <div className="py-1">
          {annotation.metadata.entries.map((entry) => (
            <LocalCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.text}
              onCancel={() => removeAnnotationEntry(entry.id)}
              onComment={(text) => submitAnnotationEntry(entry.id, text)}
              onDelete={() => removeAnnotationEntry(entry.id)}
            />
          ))}
        </div>
      )}
    />
  );
}

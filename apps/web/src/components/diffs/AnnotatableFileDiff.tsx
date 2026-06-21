import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewProps,
  FileDiff,
  type FileDiffProps,
} from "@pierre/diffs/react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo, useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32 } from "~/lib/diffRendering";
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

interface AnnotatableFileDiffProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: FileDiffProps<DiffCommentAnnotationGroup>["options"];
  renderHeaderMetadata?: FileDiffProps<DiffCommentAnnotationGroup>["renderHeaderMetadata"];
  renderHeaderPrefix: (fileDiff: FileDiffMetadata) => ReactNode;
}

export function AnnotatableFileDiff({
  fileDiff,
  filePath,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  renderHeaderMetadata,
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
      renderHeaderMetadata={(metadataFileDiff) => renderHeaderMetadata?.(metadataFileDiff)}
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

interface AnnotatableCodeViewProps {
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    collapsed: boolean;
  }>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: NonNullable<CodeViewProps<DiffCommentAnnotationGroup>["options"]>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderHeaderMetadata: (fileDiff: FileDiffMetadata) => ReactNode;
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
  files,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  className,
  renderHeaderMetadata,
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
  const [draft, setDraft] = useState<{
    fileKey: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);

  const filesByKey = useMemo(() => new Map(files.map((file) => [file.fileKey, file])), [files]);
  const items = useMemo<CodeViewDiffItem<DiffCommentAnnotationGroup>[]>(
    () =>
      files.map(({ fileDiff, filePath, fileKey, collapsed }) => {
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
            `${collapsed ? "1" : "0"}:${annotations
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
        setDraft(null);
      } else {
        removeReviewComment(composerDraftTarget, entryId);
      }
    },
    [composerDraftTarget, draft, removeReviewComment],
  );

  const submitEntry = useCallback(
    (entryId: string, text: string) => {
      const entry = draft?.annotation.metadata.entries.find(
        (candidate) => candidate.id === entryId,
      );
      const file = draft ? filesByKey.get(draft.fileKey) : undefined;
      if (!entry || !file) return;
      const comment = buildDiffReviewComment({
        id: entry.id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: entry.range,
        text,
      });
      if (comment) addReviewComment(composerDraftTarget, comment);
      setSelectedLines(null);
      setDraft(null);
    },
    [addReviewComment, composerDraftTarget, draft, filesByKey, sectionId, sectionTitle],
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
      setDraft({
        fileKey: item.id,
        annotation: {
          side: annotationSide(range),
          lineNumber: range.end,
          metadata: {
            entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
          },
        },
      });
    },
    [filesByKey, sectionId, sectionTitle],
  );

  const hasOpenComment = draft !== null;
  return (
    <CodeView<DiffCommentAnnotationGroup>
      {...(viewerRef ? { ref: viewerRef } : {})}
      {...(className ? { className } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: !hasOpenComment,
        enableLineSelection: !hasOpenComment,
        onLineSelectionEnd: beginComment,
      }}
      renderHeaderMetadata={(item) =>
        item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null
      }
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(annotation) => (
        <div className="py-1">
          {annotation.metadata.entries.map((entry) => (
            <LocalCommentAnnotation
              key={entry.id}
              kind={entry.kind}
              rangeLabel={entry.rangeLabel}
              text={entry.text}
              onCancel={() => removeEntry(entry.id)}
              onComment={(text) => submitEntry(entry.id, text)}
              onDelete={() => removeEntry(entry.id)}
            />
          ))}
        </div>
      )}
    />
  );
}

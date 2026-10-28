import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle, CodeViewProps } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  buildFileDiffContentVersion,
  fnv1a32,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "~/lib/diffRendering";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { isDiffCommentAnchorCurrent, type DiffCommentAnchor } from "./AnnotatableCodeView.logic";
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
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;
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
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  pendingFiles: ReadonlyArray<FileDiffMetadata>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  onScroll?: CodeViewProps<DiffCommentAnnotationGroup, undefined>["onScroll"];
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
  onRevealSearchMatch: (fileKey: string) => void;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  environmentId,
  projectId,
  codeViewKey,
  files,
  pendingFiles,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  onScroll,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
    anchor: DiffCommentAnchor;
  } | null>(null);
  const [draft, setDraft] = useState<
    | (DiffCommentAnchor & {
        annotation: DiffCommentLineAnnotation;
      })
    | null
  >(null);
  const [draftText, setDraftText] = useState("");

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  if (draft !== null && !isDiffCommentAnchorCurrent(draft, filesByKey, pendingFiles)) {
    setDraft(null);
    setDraftText("");
  }
  if (
    selectedLines !== null &&
    !isDiffCommentAnchorCurrent(selectedLines.anchor, filesByKey, pendingFiles)
  ) {
    setSelectedLines(null);
  }
  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
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
      const annotations = draft?.fileKey === fileKey ? [...persisted, draft.annotation] : persisted;
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
    },
  );

  const removeEntry = (entryId: string) => {
    setSelectedLines(null);
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      setDraftText("");
    } else {
      removeReviewComment(composerDraftTarget, entryId);
    }
  };

  const submitEntry = useStableCallback((entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    const file = draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!entry || !file || draft?.fileVersion !== file.fileVersion) return;
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
    setDraftText("");
  });

  const beginComment = useStableCallback(
    (range: SelectedLineRange | null, context: DiffSelectionContext) => {
      if (!range) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const file = filesByKey.get(item.id);
      if (!file || file.fileVersion !== buildFileDiffContentVersion(item.fileDiff)) return;
      const id = nextFileCommentId();
      const filePath = resolveFileDiffPath(item.fileDiff);
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath,
        fileDiff: item.fileDiff,
        range,
        text: "",
      });
      if (!comment) return;
      setDraftText("");
      setDraft({
        fileKey: item.id,
        fileVersion: file.fileVersion,
        filePath,
        previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
        annotation: {
          side: annotationSide(range),
          lineNumber: range.end,
          metadata: {
            entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
          },
        },
      });
    },
  );

  return (
    <StyledDiffCodeView<DiffCommentAnnotationGroup>
      key={codeViewKey}
      {...(viewerRef ? { viewerRef } : {})}
      {...(onScroll ? { onScroll } : {})}
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
      onSelectedLinesChange={(selection) => {
        const file = selection === null ? undefined : filesByKey.get(selection.id);
        setSelectedLines(
          selection !== null && file !== undefined
            ? {
                ...selection,
                anchor: {
                  fileKey: file.fileKey,
                  fileVersion: file.fileVersion,
                  filePath: file.filePath,
                  previousFilePath: resolveFileDiffPreviousPath(file.fileDiff),
                },
              }
            : null,
        );
      }}
      options={{
        ...options,
        enableGutterUtility: draft === null,
        enableLineSelection: draft === null,
        onGutterUtilityClick: beginComment,
        onRevealSearchMatch: (item) => onRevealSearchMatch(item.id),
      }}
      renderHeaderFilenameSuffix={(item) =>
        item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
      }
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(...[annotation]) => {
        const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
        return (
          <div
            className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
          >
            {annotation.metadata.entries.map((entry) => (
              <DiffCommentAnnotation
                key={entry.id}
                environmentId={environmentId}
                projectId={projectId}
                ownerKey={JSON.stringify([
                  environmentId,
                  composerDraftTarget,
                  codeViewKey,
                  entry.id,
                ])}
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
  );
}

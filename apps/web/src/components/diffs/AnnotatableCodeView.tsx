import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle, CodeViewProps } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { fnv1a32, resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";
import { definePluginComponent } from "~/plugins/features";

export const AnnotatableCodeView = definePluginComponent(
  "component:components/diffs/AnnotatableCodeView/AnnotatableCodeView",
  PluginOriginalAnnotatableCodeView,
);

const DiffHeaderMetadata = definePluginComponent(
  "diff.header.metadata",
  ({
    fileDiff,
    render,
  }: {
    fileDiff: FileDiffMetadata;
    render: (fileDiff: FileDiffMetadata) => ReactNode;
  }) => render(fileDiff),
);
const DiffHeaderFilenameSuffix = definePluginComponent(
  "diff.header.filename-suffix",
  ({
    fileDiff,
    render,
  }: {
    fileDiff: FileDiffMetadata;
    render: (fileDiff: FileDiffMetadata) => ReactNode;
  }) => render(fileDiff),
);
const DiffHeaderPrefix = definePluginComponent(
  "diff.header.prefix",
  ({
    fileDiff,
    fileKey,
    collapsed,
    render,
  }: {
    fileDiff: FileDiffMetadata;
    fileKey: string;
    collapsed: boolean;
    render: (fileDiff: FileDiffMetadata, fileKey: string, collapsed: boolean) => ReactNode;
  }) => render(fileDiff, fileKey, collapsed),
);
const DiffFooter = definePluginComponent("diff.footer", ({ render }: { render: () => ReactNode }) =>
  render(),
);
const DiffAnnotationGroup = definePluginComponent(
  "diff.annotation",
  (props: {
    hasDraft: boolean;
    annotation: LineAnnotation<DiffCommentAnnotationGroup>;
    children: ReactNode;
  }) => (
    <div
      className={props.hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
    >
      {props.children}
    </div>
  ),
);

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
  onFileCollapsedChange: (fileKey: string, collapsed: boolean) => void;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

function PluginOriginalAnnotatableCodeView({
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
  onFileCollapsedChange,
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
    filePath: string;
    previousFilePath: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const renderPluginFooter = () =>
    renderCodeViewFooter ? <DiffFooter render={renderCodeViewFooter} /> : null;

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  if (
    draft !== null &&
    !filesByKey.has(draft.fileKey) &&
    // Lazy placeholders have provisional change types, so match both paths instead.
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === draft.filePath &&
        resolveFileDiffPreviousPath(file) === draft.previousFilePath,
    )
  ) {
    setDraft(null);
    setDraftText("");
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

  const submitEntry = (entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
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
    setDraftText("");
  };

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
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
  };

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
              item.type === "diff" ? (
                <DiffHeaderMetadata fileDiff={item.fileDiff} render={renderHeaderMetadata} />
              ) : null,
          }
        : {})}
      {...(renderCodeViewFooter ? { renderCodeViewFooter: renderPluginFooter } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: draft === null,
        enableLineSelection: draft === null,
        onGutterUtilityClick: beginComment,
        onItemCollapsedChange: (_item, nextItem) =>
          onFileCollapsedChange(nextItem.id, nextItem.collapsed === true),
      }}
      renderHeaderFilenameSuffix={(item) =>
        item.type === "diff" ? (
          <DiffHeaderFilenameSuffix fileDiff={item.fileDiff} render={renderHeaderFilenameSuffix} />
        ) : null
      }
      renderHeaderPrefix={(item) =>
        item.type === "diff" ? (
          <DiffHeaderPrefix
            fileDiff={item.fileDiff}
            fileKey={item.id}
            collapsed={item.collapsed === true}
            render={renderHeaderPrefix}
          />
        ) : null
      }
      renderAnnotation={(...[annotation]) => {
        const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
        return (
          <DiffAnnotationGroup hasDraft={hasDraft} annotation={annotation}>
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
          </DiffAnnotationGroup>
        );
      }}
    />
  );
}

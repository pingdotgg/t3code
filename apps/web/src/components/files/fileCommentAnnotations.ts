import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";

import type { ReviewCommentContext } from "~/reviewCommentContext";

export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

let fileCommentSequence = 0;

export function nextFileCommentId(): string {
  fileCommentSequence += 1;
  return `file-comment-${Date.now()}-${fileCommentSequence}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function formatFileCommentRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}

export function appendFileCommentEntry(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
  entry: FileCommentAnnotationEntry,
): FileCommentLineAnnotation[] {
  const existingIndex = annotations.findIndex(
    (annotation) => annotation.lineNumber === entry.endLine,
  );
  if (existingIndex < 0) {
    return [...annotations, { lineNumber: entry.endLine, metadata: { entries: [entry] } }];
  }
  return annotations.map((annotation, index) =>
    index === existingIndex
      ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, entry] } }
      : annotation,
  );
}

export function fileCommentAnnotationsFromReviewComments(
  reviewComments: ReadonlyArray<ReviewCommentContext>,
  relativePath: string,
): FileCommentLineAnnotation[] {
  return reviewComments
    .filter(
      (comment) =>
        comment.sectionId === `file:${relativePath}` && comment.filePath === relativePath,
    )
    .reduce<FileCommentLineAnnotation[]>(
      (annotations, comment) =>
        appendFileCommentEntry(annotations, {
          id: comment.id,
          kind: "comment",
          startLine: comment.startIndex + 1,
          endLine: comment.endIndex + 1,
          text: comment.text,
        }),
      [],
    );
}

export function pruneFileCommentAnnotations(
  annotations: FileCommentLineAnnotation[],
  reviewComments: ReadonlyArray<ReviewCommentContext>,
): FileCommentLineAnnotation[] {
  const storedIds = new Set(reviewComments.map(({ id }) => id));
  const keep = (entry: FileCommentAnnotationEntry) =>
    entry.kind === "draft" || storedIds.has(entry.id);
  if (annotations.every((annotation) => annotation.metadata.entries.every(keep))) {
    return annotations;
  }
  return annotations.flatMap((annotation) => {
    const entries = annotation.metadata.entries.filter(keep);
    return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
  });
}

import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";

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

export function reconcileFileCommentAnnotations(
  current: FileCommentLineAnnotation[],
  next: FileCommentLineAnnotation[],
): FileCommentLineAnnotation[] {
  if (next === current) return current;
  const remapped = remapFileCommentAnnotations(next);
  if (
    remapped.length === current.length &&
    remapped.every((annotation, annotationIndex) => {
      const currentAnnotation = current[annotationIndex];
      if (
        currentAnnotation === undefined ||
        annotation.lineNumber !== currentAnnotation.lineNumber ||
        annotation.metadata.entries.length !== currentAnnotation.metadata.entries.length
      ) {
        return false;
      }
      return annotation.metadata.entries.every((entry, entryIndex) => {
        const currentEntry = currentAnnotation.metadata.entries[entryIndex];
        return (
          currentEntry !== undefined &&
          entry.id === currentEntry.id &&
          entry.kind === currentEntry.kind &&
          entry.startLine === currentEntry.startLine &&
          entry.endLine === currentEntry.endLine &&
          entry.text === currentEntry.text
        );
      });
    })
  ) {
    return current;
  }
  return remapped;
}

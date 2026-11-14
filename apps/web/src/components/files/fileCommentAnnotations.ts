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

/** Keeps drafts and the comments still in the prompt; returns the same array when nothing left. */
export function retainPromptFileComments(
  annotations: FileCommentLineAnnotation[],
  promptCommentIds: ReadonlySet<string>,
): FileCommentLineAnnotation[] {
  const isRetained = (entry: FileCommentAnnotationEntry) =>
    entry.kind === "draft" || promptCommentIds.has(entry.id);
  if (annotations.every((annotation) => annotation.metadata.entries.every(isRetained))) {
    return annotations;
  }
  return annotations.flatMap((annotation) => {
    const entries = annotation.metadata.entries.filter(isRetained);
    return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
  });
}

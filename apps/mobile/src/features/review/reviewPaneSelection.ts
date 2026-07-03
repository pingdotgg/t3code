export interface ReviewPaneFileSelection {
  readonly sectionId: string | null;
  readonly fileId: string | null;
}

export function resolveSelectedReviewFileId(input: {
  readonly selection: ReviewPaneFileSelection;
  readonly sectionId: string | null;
  readonly availableFileIds: ReadonlyArray<string>;
}): string | null {
  if (input.selection.sectionId !== input.sectionId || input.selection.fileId === null) {
    return null;
  }

  return input.availableFileIds.includes(input.selection.fileId) ? input.selection.fileId : null;
}

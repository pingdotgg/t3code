import { useCallback, useMemo } from "react";

import { updateReviewExpandedFileIds, updateReviewViewedFileIds } from "./reviewState";
import type { ReviewRenderableFile } from "./reviewModel";

// File ids are scoped to one diff text, so a refresh renames every file. Expansion is
// stored by path, which survives a refresh.
function getExpandedReviewFilePaths(
  files: ReadonlyArray<ReviewRenderableFile>,
  filePaths: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const paths = files.map((file) => file.path);
  return filePaths === undefined ? paths : paths.filter((path) => filePaths.includes(path));
}

function getValidReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return files.map((file) => file.id);
  }

  const fileIdSet = new Set(files.map((file) => file.id));
  return fileIds.filter((id) => fileIdSet.has(id));
}

function getValidExplicitReviewFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  fileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (fileIds === undefined) {
    return [];
  }

  return getValidReviewFileIds(files, fileIds);
}

function toggleReviewFileId(fileIds: ReadonlyArray<string>, fileId: string): ReadonlyArray<string> {
  return fileIds.includes(fileId) ? fileIds.filter((id) => id !== fileId) : [...fileIds, fileId];
}

function removeReviewFileId(fileIds: ReadonlyArray<string>, fileId: string): ReadonlyArray<string> {
  return fileIds.includes(fileId) ? fileIds.filter((id) => id !== fileId) : fileIds;
}

export function useReviewFileVisibility(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly files: ReadonlyArray<ReviewRenderableFile>;
  readonly cachedExpandedFileIds: ReadonlyArray<string> | undefined;
  readonly cachedViewedFileIds: ReadonlyArray<string> | undefined;
}) {
  const { cachedExpandedFileIds, cachedViewedFileIds, files, sectionId, threadKey } = input;

  const expandedFileIds = useMemo(() => {
    const expandedPaths = new Set(getExpandedReviewFilePaths(files, cachedExpandedFileIds));
    return files.filter((file) => expandedPaths.has(file.path)).map((file) => file.id);
  }, [cachedExpandedFileIds, files]);
  const viewedFileIds = useMemo(
    () => getValidExplicitReviewFileIds(files, cachedViewedFileIds),
    [cachedViewedFileIds, files],
  );
  const collapsedFileIds = useMemo(() => {
    const expandedFileIdSet = new Set(expandedFileIds);
    return files.reduce<string[]>((fileIds, file) => {
      if (!expandedFileIdSet.has(file.id)) {
        fileIds.push(file.id);
      }
      return fileIds;
    }, []);
  }, [expandedFileIds, files]);

  const toggleExpandedFile = useCallback(
    (fileId: string) => {
      if (!threadKey || !sectionId) {
        return;
      }

      const path = files.find((file) => file.id === fileId)?.path;
      if (path === undefined) {
        return;
      }
      updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(getExpandedReviewFilePaths(files, existing), path),
      );
    },
    [files, sectionId, threadKey],
  );

  const toggleViewedFile = useCallback(
    (fileId: string) => {
      if (!threadKey || !sectionId) {
        return;
      }

      const shouldCollapse = !viewedFileIds.includes(fileId);
      updateReviewViewedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(getValidExplicitReviewFileIds(files, existing), fileId),
      );

      const path = files.find((file) => file.id === fileId)?.path;
      if (shouldCollapse && path !== undefined) {
        updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
          removeReviewFileId(getExpandedReviewFilePaths(files, existing), path),
        );
      }
    },
    [files, sectionId, threadKey, viewedFileIds],
  );

  return {
    expandedFileIds,
    viewedFileIds,
    collapsedFileIds,
    toggleExpandedFile,
    toggleViewedFile,
  };
}

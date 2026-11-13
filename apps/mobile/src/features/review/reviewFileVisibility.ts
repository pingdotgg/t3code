import { useCallback, useMemo } from "react";

import { updateReviewExpandedFileIds, updateReviewViewedFileIds } from "./reviewState";
import type { ReviewRenderableFile } from "./reviewModel";

// File ids are scoped to one diff text, so a refresh renames every file. Expansion is
// stored by path, which survives a refresh; the occurrence index keeps apart entries
// that share a path, such as the deletion and addition when a file becomes a symlink.
function getReviewFileExpansionKeys(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const occurrence = seen.get(file.path) ?? 0;
    seen.set(file.path, occurrence + 1);
    return `${occurrence}:${file.path}`;
  });
}

function getExpandedReviewFileKeys(
  keys: ReadonlyArray<string>,
  storedKeys: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  return storedKeys === undefined ? keys : keys.filter((key) => storedKeys.includes(key));
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

  const expansionKeys = useMemo(() => getReviewFileExpansionKeys(files), [files]);
  const expandedFileIds = useMemo(() => {
    const expandedKeys = new Set(getExpandedReviewFileKeys(expansionKeys, cachedExpandedFileIds));
    return files
      .filter((_, index) => expandedKeys.has(expansionKeys[index]!))
      .map((file) => file.id);
  }, [cachedExpandedFileIds, expansionKeys, files]);
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

      const key = expansionKeys[files.findIndex((file) => file.id === fileId)];
      if (key === undefined) {
        return;
      }
      updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
        toggleReviewFileId(getExpandedReviewFileKeys(expansionKeys, existing), key),
      );
    },
    [expansionKeys, files, sectionId, threadKey],
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

      const key = expansionKeys[files.findIndex((file) => file.id === fileId)];
      if (shouldCollapse && key !== undefined) {
        updateReviewExpandedFileIds(threadKey, sectionId, (existing) =>
          removeReviewFileId(getExpandedReviewFileKeys(expansionKeys, existing), key),
        );
      }
    },
    [expansionKeys, files, sectionId, threadKey, viewedFileIds],
  );

  return {
    expandedFileIds,
    viewedFileIds,
    collapsedFileIds,
    toggleExpandedFile,
    toggleViewedFile,
  };
}

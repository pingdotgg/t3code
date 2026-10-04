import type { FileDiffMetadata } from "@pierre/diffs";

const INITIAL_PATCH_INDICES = [0, 1, 2, 3] as const;
const EMPTY_RETAINED_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

export interface ReviewSnapshotIdentity {
  readonly environmentId: string | undefined;
  readonly cwd: string | undefined;
  readonly kind: string | undefined;
  readonly baseRef: string | null;
  readonly ignoreWhitespace: boolean;
}

/** Identity of a review that survives a new git snapshot. The diff hash is not part of it. */
export function reviewSnapshotFamily(input: ReviewSnapshotIdentity): string {
  return JSON.stringify([
    input.environmentId,
    input.cwd,
    input.kind,
    input.baseRef,
    input.ignoreWhitespace,
  ]);
}

export function reviewSnapshotScope(family: string, diffHash: string | undefined): string {
  return JSON.stringify([family, diffHash ?? null]);
}

/**
 * Keep requesting the files already on screen when the snapshot changes. A different
 * review starts over at the first page.
 */
export function reviewPatchIndicesForFamily(
  requested: { readonly family: string; readonly indices: readonly number[] },
  family: string,
): readonly number[] {
  return requested.family === family ? requested.indices : INITIAL_PATCH_INDICES;
}

export function isPendingReviewFile(file: { readonly cacheKey?: string | undefined }): boolean {
  return file.cacheKey?.endsWith(":pending") === true;
}

/** Show the file already on screen until its replacement patch arrives. */
export function retainedReviewFile<T extends { readonly cacheKey?: string | undefined }>(input: {
  readonly loaded: T | null;
  readonly previous: T | undefined;
  readonly placeholder: T;
  readonly sameFamily: boolean;
}): T {
  if (input.loaded) return input.loaded;
  if (input.sameFamily && input.previous && !isPendingReviewFile(input.previous)) {
    return input.previous;
  }
  return input.placeholder;
}

export function retainLoadedReviewFiles(
  previous: ReadonlyMap<string, FileDiffMetadata>,
  files: readonly FileDiffMetadata[],
  pathOf: (file: FileDiffMetadata) => string,
): ReadonlyMap<string, FileDiffMetadata> {
  const next = new Map<string, FileDiffMetadata>();
  for (const file of files) {
    if (!isPendingReviewFile(file)) next.set(pathOf(file), file);
  }
  if (next.size === previous.size) {
    let unchanged = true;
    for (const [path, file] of next) {
      if (previous.get(path) !== file) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return previous;
  }
  return next.size === 0 ? EMPTY_RETAINED_FILES : next;
}

/** The viewer remounts for a new review section, not for a new git snapshot of the same one. */
export function reviewDiffViewerKey(
  sectionMountKey: string,
  snapshotFamily: string | null,
): string {
  return snapshotFamily === null
    ? `${sectionMountKey}:preview`
    : `${sectionMountKey}:${snapshotFamily}`;
}

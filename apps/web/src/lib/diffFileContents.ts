import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  /** The comparison identity Pierre carries into its hydrated render cache. */
  readonly cacheKey: string;
}

interface PullRequestDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly commit: string | null;
  readonly cacheKey: string;
}

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type GetPullRequestDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

/** Turns the host's Git file-content RPC into the full-file loader Pierre uses for hunk expansion. */
export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

/**
 * Bounds for one pull-request file-contents loader's memo. Each entry holds up to two whole
 * files (the host caps each at 1 MiB), so the size cap — not the entry count — is what keeps a
 * long expanding session from growing without bound. Sizes are UTF-16 code units, not bytes;
 * still a bound, just a conservative one for non-BMP text. Exported for tests.
 */
export const PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES = 30;
export const PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_BYTES = 10 * 1024 * 1024;

/** Loads host-backed PR files, which may name revisions this checkout has never fetched. */
export function createPullRequestDiffFileContentsLoader<E>(
  getDiffFileContents: GetPullRequestDiffFileContents<E>,
  source: PullRequestDiffFileContentsSource,
): FileDiffContentsLoader {
  // One hunk expansion costs a refs lookup plus up to two raw file reads on the host, so an
  // expansion is memoized by what it reads: the comparison is fixed for the life of this loader
  // (its cache key already carries the revision), and only the file identity varies per call.
  // Concurrent expansions of the same file share one request rather than racing two.
  // Failures are never kept: a transient host error must not pin a file to its error.
  interface SettledEntry {
    readonly oldContents: string;
    readonly newContents: string;
    readonly size: number;
  }
  const settled = new Map<string, SettledEntry>();
  const inflight = new Map<string, Promise<SettledEntry>>();
  let settledBytes = 0;
  // NUL separates the fields: git paths never contain it, while spaces are legal in them.
  const keyOf = (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => [input.changeType, input.oldPath, input.newPath].join("\u0000");
  const takeSettled = (key: string): SettledEntry | null => {
    const hit = settled.get(key);
    if (!hit) return null;
    // Refresh recency so the eviction below drops the least recently expanded file.
    settled.delete(key);
    settled.set(key, hit);
    return hit;
  };
  const storeSettled = (key: string, value: SettledEntry) => {
    const previous = settled.get(key);
    if (previous !== undefined) {
      settled.delete(key);
      settledBytes -= previous.size;
    }
    while (
      settled.size > 0 &&
      (settled.size >= PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_ENTRIES ||
        settledBytes + value.size > PULL_REQUEST_FILE_CONTENTS_CACHE_MAX_BYTES)
    ) {
      const oldest = settled.keys().next();
      if (oldest.done) break;
      const removed = settled.get(oldest.value);
      settled.delete(oldest.value);
      settledBytes -= removed?.size ?? 0;
    }
    settled.set(key, value);
    settledBytes += value.size;
  };
  const load = async (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }): Promise<{ readonly oldContents: string; readonly newContents: string }> => {
    const key = keyOf(input);
    const hit = takeSettled(key);
    if (hit) return hit;
    const ongoing = inflight.get(key);
    if (ongoing) return ongoing;
    const pending = (async (): Promise<SettledEntry> => {
      const result = await getDiffFileContents({
        environmentId: source.environmentId,
        input: {
          ...source.reference,
          ...(source.commit === null ? {} : { commit: source.commit }),
          changeType: input.changeType,
          oldPath: input.oldPath,
          newPath: input.newPath,
        },
      });
      if (result._tag !== "Success") {
        throw squashAtomCommandFailure(result);
      }
      return {
        oldContents: result.value.oldContents,
        newContents: result.value.newContents,
        // UTF-16 units, not bytes (see above): bounded either way, no extra measuring cost.
        size: result.value.oldContents.length + result.value.newContents.length,
      };
    })();
    inflight.set(key, pending);
    try {
      const value = await pending;
      storeSettled(key, value);
      return value;
    } finally {
      inflight.delete(key);
    }
  };
  return createDiffFileContentsLoader(load, source.cacheKey);
}

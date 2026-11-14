import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useState } from "react";

import { getRenderablePatch, resolveFileDiffPath } from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { pullRequestReviewKey } from "../pullRequestReviewStore";

interface LoadedDiff {
  readonly key: string;
  readonly cursor: string | null;
  readonly done: boolean;
  readonly files: ReadonlyMap<string, FileDiffMetadata>;
  readonly folded: unknown;
}

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

export function useGuideDiffFiles({
  environmentId,
  reference,
  headSha,
  wantedPaths,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  headSha: string;
  wantedPaths: ReadonlyArray<string>;
}) {
  const key = `${environmentId}:${pullRequestReviewKey(reference)}:${headSha}`;
  const [loaded, setLoaded] = useState<LoadedDiff>({
    key,
    cursor: null,
    done: false,
    files: NO_FILES,
    folded: null,
  });
  const current: LoadedDiff =
    loaded.key === key ? loaded : { key, cursor: null, done: false, files: NO_FILES, folded: null };
  const registry = useContext(RegistryContext);
  const isMissing = (diff: LoadedDiff) => wantedPaths.some((path) => !diff.files.has(path));
  const pageAtom = (cursor: string | null) =>
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(cursor === null ? {} : { cursor }) },
    });
  const loading = isMissing(current) && !current.done;
  const query = useEnvironmentQuery(loading ? pageAtom(current.cursor) : null);

  // One update for every settled page: an update per page trips React's re-render limit.
  let next = current;
  let data = query.isPending ? null : query.data;
  while (data !== null && !next.done && next.folded !== data && isMissing(next)) {
    const parsed = getRenderablePatch(
      data.patch,
      `pull-request-guide:${key}:${next.cursor ?? "first"}`,
    );
    const files = new Map(next.files);
    if (parsed?.kind === "files") {
      for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
    }
    next = { key, cursor: data.nextCursor, done: data.nextCursor === null, files, folded: data };
    const result = next.done || !isMissing(next) ? null : registry.get(pageAtom(next.cursor));
    data = result === null || result.waiting ? null : AsyncResult.getOrElse(result, () => null);
  }
  if (next !== current) setLoaded(next);

  return {
    files: current.files,
    loading: loading && query.error === null,
    error: loading ? query.error : null,
    retry: query.refresh,
  };
}

import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { parseUnifiedDiff, type ParsedDiffFile } from "./pullRequestDiffParse";

/**
 * Walks the host's diff slices and keeps every file that has arrived so far.
 * `truncated` is about a file the host would not inline; `nextCursor` is about
 * whether another slice exists. Those are not the same signal.
 */
export function usePullRequestDiffSlices(input: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef | null;
  readonly enabled: boolean;
}) {
  const scopeKey =
    input.reference === null
      ? ""
      : `${input.environmentId}:${input.reference.projectId}:${input.reference.repository}:${input.reference.number}`;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<{
    readonly key: string;
    readonly files: ReadonlyArray<ParsedDiffFile>;
    readonly nextCursor: string | null;
    readonly truncated: boolean;
  } | null>(null);

  useEffect(() => {
    setCursor(undefined);
    setAccumulated(null);
  }, [scopeKey]);

  const firstPageAtom =
    !input.enabled || input.reference === null
      ? null
      : pullRequestEnvironment.diff({
          environmentId: input.environmentId,
          input: { ...input.reference },
        });
  const pageAtom =
    !input.enabled || input.reference === null
      ? null
      : pullRequestEnvironment.diff({
          environmentId: input.environmentId,
          input: {
            ...input.reference,
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
  const firstPageQuery = useEnvironmentQuery(firstPageAtom);
  const query = useEnvironmentQuery(pageAtom);

  useEffect(() => {
    if (query.data === null || query.isPending) return;
    const parsed = parseUnifiedDiff(query.data.patch);
    const nextCursor = query.data.nextCursor;
    const truncated = query.data.truncated;
    setAccumulated((current) => {
      if (current === null || current.key !== scopeKey || cursor === undefined) {
        return {
          key: scopeKey,
          files: parsed,
          nextCursor,
          truncated,
        };
      }
      const seen = new Set(current.files.map((file) => file.key));
      return {
        key: scopeKey,
        files: [...current.files, ...parsed.filter((file) => !seen.has(file.key))],
        nextCursor,
        truncated: current.truncated || truncated,
      };
    });
  }, [cursor, query.data, query.isPending, scopeKey]);

  const files = accumulated?.key === scopeKey ? accumulated.files : [];
  const nextCursor = accumulated?.key === scopeKey ? accumulated.nextCursor : null;

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    if (nextCursor === cursor) {
      if (query.error !== null) query.refresh();
      return;
    }
    setCursor(nextCursor);
  }, [cursor, nextCursor, query]);

  const refresh = useCallback(() => {
    setCursor(undefined);
    setAccumulated(null);
    firstPageQuery.refresh();
  }, [firstPageQuery]);

  return {
    files,
    nextCursor,
    truncated: accumulated?.key === scopeKey ? accumulated.truncated : false,
    loading: query.isPending && files.length === 0,
    loadingMore: query.isPending && files.length > 0,
    error: query.error,
    loadMore,
    refresh,
  };
}

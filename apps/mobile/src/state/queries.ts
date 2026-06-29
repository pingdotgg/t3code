import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { orchestrationEnvironment } from "./orchestration";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";
import {
  buildCheckpointDiffTargets,
  normalizeComposerPathSearchQuery,
  type CheckpointDiffTarget,
} from "./queryTargets";

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 200;
const COMPOSER_PATH_SEARCH_LIMIT = 20;
const VCS_REF_LIST_LIMIT = 100;

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}

function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

export function useBranches(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query?: string | null;
}) {
  const query = input.query?.trim() ?? "";
  return useEnvironmentQuery(
    input.environmentId !== null && input.cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            ...(query.length > 0 ? { query } : {}),
            limit: VCS_REF_LIST_LIMIT,
          },
        })
      : null,
  );
}

export function useComposerPathSearch(target: ComposerPathSearchTarget) {
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: normalizeComposerPathSearchQuery(target.query),
    }),
    [target.cwd, target.environmentId, target.query],
  );
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS);
  const result = useEnvironmentQuery(
    debouncedTarget.environmentId !== null &&
      debouncedTarget.cwd !== null &&
      debouncedTarget.query.length > 0
      ? projectEnvironment.searchEntries({
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            query: debouncedTarget.query,
            limit: COMPOSER_PATH_SEARCH_LIMIT,
          },
        })
      : null,
  );

  return {
    entries: result.data?.entries ?? [],
    error: result.error,
    isPending: normalizedTarget.query !== debouncedTarget.query || result.isPending,
    refresh: result.refresh,
  };
}

export function useCheckpointDiff(target: CheckpointDiffTarget) {
  const targets = useMemo(
    () => buildCheckpointDiffTargets(target),
    [
      target.environmentId,
      target.fromTurnCount,
      target.ignoreWhitespace,
      target.threadId,
      target.toTurnCount,
    ],
  );
  const fullThread = useEnvironmentQuery(
    targets.fullThread === null
      ? null
      : orchestrationEnvironment.fullThreadDiff(targets.fullThread),
  );
  const turn = useEnvironmentQuery(
    targets.turn === null ? null : orchestrationEnvironment.turnDiff(targets.turn),
  );
  return targets.fullThread === null ? turn : fullThread;
}

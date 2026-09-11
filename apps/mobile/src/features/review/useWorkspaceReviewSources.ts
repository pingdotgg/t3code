import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { useCallback, useMemo } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { reviewEnvironment } from "../../state/review";

export function useWorkspaceReviewSources(
  environmentId: EnvironmentId | undefined,
  repositories: readonly { path: string; cwd: string; available: boolean }[],
  enabled: boolean,
) {
  const queries = useMemo(
    () =>
      environmentId && enabled
        ? repositories
            .filter((repository) => repository.available)
            .map((repository) => ({
              repository,
              atom: reviewEnvironment.diffPreview({
                environmentId,
                input: { cwd: repository.cwd },
              }),
            }))
        : [],
    [environmentId, repositories, enabled],
  );
  const aggregate = useMemo(
    () =>
      Atom.make((get) =>
        queries.map(({ repository, atom }) => ({ repository, result: get(atom) })),
      ),
    [queries],
  );
  const results = useAtomValue(aggregate);
  const entries = useMemo(
    () =>
      results.flatMap(({ repository, result }) => {
        const data = Option.getOrNull(AsyncResult.value(result));
        return data ? data.sources.map((source) => ({ repository, source })) : [];
      }),
    [results],
  );
  const failure = results.find(({ result }) => AsyncResult.isFailure(result));
  const error =
    failure && AsyncResult.isFailure(failure.result)
      ? `${failure.repository.path}: ${String(Cause.squash(failure.result.cause))}`
      : null;
  const refresh = useCallback(() => {
    for (const { atom } of queries) appAtomRegistry.refresh(atom);
  }, [queries]);
  return { entries, error, isPending: results.some(({ result }) => result.waiting), refresh };
}

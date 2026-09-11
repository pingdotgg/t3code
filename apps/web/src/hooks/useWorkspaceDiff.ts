import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useMemo } from "react";
import type { WorkspaceDiffRepository } from "../lib/workspaceDiff";
import { formatEnvironmentQueryError } from "../state/query";
import { reviewEnvironment } from "../state/review";

export function useWorkspaceDiff(
  environmentId: EnvironmentId | null,
  repositories: readonly WorkspaceDiffRepository[],
  baseRefs: Readonly<Record<string, string | null>>,
  ignoreWhitespace: boolean,
) {
  const registry = useContext(RegistryContext);
  const queries = useMemo(
    () =>
      environmentId
        ? repositories
            .filter((repo) => repo.available)
            .map((repository) => {
              const baseRef = baseRefs[repository.cwd];
              return {
                repository,
                atom: reviewEnvironment.diffPreview({
                  environmentId,
                  input: {
                    cwd: repository.cwd,
                    ...(baseRef ? { baseRef } : {}),
                    ignoreWhitespace,
                  },
                }),
              };
            })
        : [],
    [environmentId, repositories, baseRefs, ignoreWhitespace],
  );
  const collection = useMemo(
    () =>
      Atom.make((get) =>
        queries.map(({ repository, atom }) => {
          const result = get(atom);
          return {
            repository,
            data: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result._tag === "Initial" || result.waiting,
          };
        }),
      ),
    [queries],
  );
  const results = useAtomValue(collection);
  const refresh = useCallback(() => {
    for (const { atom } of queries) registry.refresh(atom);
  }, [registry, queries]);
  return { results, refresh };
}

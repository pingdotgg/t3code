import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkspaceRepository } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { projectEnvironment } from "../state/projects";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../state/query";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  selectWorkspaceRepository,
  updateWorkspaceRepositorySelection,
} from "../lib/workspaceRepositories";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

const EMPTY_REPOSITORIES: readonly WorkspaceRepository[] = [];

export function useWorkspaceRepositories(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  mutationId: string | null;
  enabled: boolean;
}) {
  const { environmentId, cwd, mutationId, enabled } = input;
  const query = useEnvironmentQuery(
    enabled && environmentId !== null && cwd !== null
      ? projectEnvironment.listRepositories({ environmentId, input: { cwd } })
      : null,
  );
  const repositories = query.data?.repositories ?? EMPTY_REPOSITORIES;
  const scope = JSON.stringify([environmentId, cwd]);
  const [selection, setSelection] = useState<{
    scope: string;
    path: string | null;
    diffPath: string | null;
  } | null>(null);
  const selectedRepository = selectWorkspaceRepository(
    repositories,
    selection?.scope === scope ? selection.path : null,
  );
  const selectRepository = useCallback(
    (path: string | null) => {
      setSelection((current) => ({
        scope,
        ...updateWorkspaceRepositorySelection(current?.scope === scope ? current : null, path),
      }));
    },
    [scope],
  );
  const statusTargets = useMemo(
    () =>
      environmentId === null
        ? []
        : repositories
            .filter((repository) => repository.available)
            .map((repository) => ({
              repository,
              atom: vcsEnvironment.status({ environmentId, input: { cwd: repository.cwd } }),
            })),
    [environmentId, repositories],
  );
  const statusesAtom = useMemo(
    () =>
      Atom.make((get) =>
        statusTargets.map(({ repository, atom }) => {
          const result = get(atom);
          return {
            repository,
            status: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result.waiting,
          };
        }),
      ),
    [statusTargets],
  );
  const statuses = useAtomValue(statusesAtom);
  const refreshRepositories = query.refresh;
  const refresh = useCallback(() => {
    refreshRepositories();
    for (const { atom } of statusTargets) appAtomRegistry.refresh(atom);
  }, [refreshRepositories, statusTargets]);
  useWorkspaceMutationRefresh({
    enabled: cwd !== null,
    mutationId,
    refresh,
    resourceKey: `repositories:${scope}`,
  });
  useEffect(() => {
    if (cwd === null) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [cwd, refresh]);
  return {
    repositories,
    statuses,
    selectedRepository,
    selectRepository,
    repositoryFilter: selection?.scope === scope ? selection.diffPath : null,
    refresh,
    error: query.error,
    isPending: query.isPending,
  };
}

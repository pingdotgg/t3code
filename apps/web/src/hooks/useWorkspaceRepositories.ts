import type { EnvironmentId, VcsRepository } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

const NO_REPOSITORIES: ReadonlyArray<VcsRepository> = [];

/**
 * Repositories a multi-repo workspace folder holds. Asked only once Git status reports that
 * `cwd` is not itself a repository, so ordinary checkouts never make the request.
 */
export function useWorkspaceRepositories(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly isRepo: boolean | undefined;
}): ReadonlyArray<VcsRepository> {
  const query = useEnvironmentQuery(
    input.environmentId !== null && input.cwd !== null && input.isRepo === false
      ? vcsEnvironment.listRepositories({
          environmentId: input.environmentId,
          input: { cwd: input.cwd },
        })
      : null,
  );
  return query.data?.repositories ?? NO_REPOSITORIES;
}

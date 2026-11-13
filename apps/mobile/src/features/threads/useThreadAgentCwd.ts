import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { confirmedThreadAgentCwd, threadAgentCwd } from "@t3tools/shared/path";

import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";

/** Where the thread's agent works: the project's own directory, also inside a worktree. */
export function useThreadAgentCwd(
  environmentId: EnvironmentId | null,
  project: {
    readonly workspaceRoot: string;
    readonly repositoryRoot?: string | null | undefined;
  } | null,
  worktreePath: string | null,
): string | null {
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const candidate = project
    ? threadAgentCwd({
        projectRoot: project.workspaceRoot,
        repositoryRoot: project.repositoryRoot,
        worktreePath,
      })
    : null;
  const nested = worktreePath !== null && candidate !== null && candidate !== worktreePath;
  const metadata = useEnvironmentQuery(
    nested && environmentId !== null && canRead
      ? projectEnvironment.fileMetadata({ environmentId, input: { path: candidate } })
      : null,
  );
  return nested ? confirmedThreadAgentCwd(candidate, worktreePath, metadata) : candidate;
}

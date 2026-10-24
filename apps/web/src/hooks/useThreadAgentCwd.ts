import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { threadAgentCwd } from "@t3tools/shared/projectScripts";
import { useEffect, useRef } from "react";

import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * The thread agent's cwd. Like the server, a worktree whose branch has no
 * directory at the project's subdirectory falls back to the worktree root.
 * `checkoutRevision` changes when the checkout may have, such as a branch
 * switch or a finished run, and re-checks that directory.
 */
export function useThreadAgentCwd(
  environmentId: EnvironmentId | null,
  project: {
    readonly workspaceRoot: string;
    readonly repositoryRoot?: string | null | undefined;
  } | null,
  worktreePath: string | null,
  checkoutRevision: string,
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
  const queried = nested && environmentId !== null && canRead;
  const entry = useEnvironmentQuery(
    queried ? projectEnvironment.fileMetadata({ environmentId, input: { path: candidate } }) : null,
  ).data;
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  const checkedRevision = useRef(checkoutRevision);
  useEffect(() => {
    if (checkedRevision.current === checkoutRevision) return;
    checkedRevision.current = checkoutRevision;
    if (queried) void invalidate({ environmentId, input: { paths: [candidate] } });
  }, [checkoutRevision, queried, environmentId, candidate, invalidate]);
  if (!nested) return candidate;
  return entry === null || (entry !== undefined && entry.kind !== "directory")
    ? worktreePath
    : candidate;
}

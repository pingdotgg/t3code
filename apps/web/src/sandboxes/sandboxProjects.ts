import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ensureSandboxProject,
  type SandboxProjectInput,
} from "@t3tools/client-runtime/sandboxes/projects";
import { useStableCallback } from "../hooks/useStableCallback";

import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { newProjectId } from "../lib/utils";
import { readProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

export function useEnsureSandboxProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  // Stable, since the connection coordinator runs it from an effect.
  return useStableCallback((input: SandboxProjectInput) =>
    ensureSandboxProject(
      {
        hasProjectAt: (environmentId, workspaceRoot) =>
          findProjectByPath(
            readProjects().filter((project) => project.environmentId === environmentId),
            workspaceRoot,
          ) !== undefined,
        createProject: async ({ environmentId, title, workspaceRoot }) => {
          const result = await createProject({
            environmentId,
            input: {
              projectId: newProjectId(),
              title,
              workspaceRoot,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (result._tag !== "Failure") return null;
          const failure = squashAtomCommandFailure(result);
          return failure instanceof Error ? failure.message : "Could not add the project.";
        },
      },
      input,
    ),
  );
}

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { getNewProjectGitHubRepository } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * Starts a project from a name. The server makes a folder under the chosen
 * parent (or `newProjectsRoot`) with a README, an icon, and a first commit; this then
 * opens a new thread draft in it. With `github`, it also publishes the
 * repository as private, without holding up the draft.
 *
 * Resolves to whether the project was created.
 */
export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  const publishToGitHub = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
      readonly account: string | null;
    }) => {
      const result = await publishRepository({
        environmentId: input.environmentId,
        input: {
          cwd: input.workspaceRoot,
          provider: "github",
          repository: getNewProjectGitHubRepository(input, input.workspaceRoot),
          visibility: "private",
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the GitHub repository",
              description: `${errorMessage(squashAtomCommandFailure(result))} Use Publish Repository in the Git menu to try again.`,
            }),
          );
        }
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Published to GitHub",
          description: result.value.repository.nameWithOwner,
        }),
      );
    },
    [publishRepository],
  );

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly parentDirectory?: string;
      readonly github: { readonly account: string | null } | null;
    }): Promise<boolean> => {
      const result = await createNew({
        environmentId: input.environmentId,
        input: {
          name: input.name,
          ...(input.parentDirectory ? { parentDirectory: input.parentDirectory } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the project",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }

      const { projectId, workspaceRoot, commitError } = result.value;
      // Report the actual path, including any suffix added for an occupied name.
      toastManager.add(
        stackedThreadToast(
          commitError === undefined
            ? { type: "success", title: `Created ${input.name}`, description: workspaceRoot }
            : {
                type: "warning",
                title: `Created ${input.name} without a first commit`,
                description: `${commitError} The project is in ${workspaceRoot}.`,
              },
        ),
      );
      if (input.github) {
        void publishToGitHub({
          environmentId: input.environmentId,
          workspaceRoot,
          account: input.github.account,
        });
      }

      const projectRef = scopeProjectRef(input.environmentId, projectId);
      // Drafts key off the project's stored path, so wait for the create event
      // to reach the store before opening one.
      const project = await waitForProject(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
          }),
        );
        return null;
      });
      if (project === null) return true;
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to open project",
            description: errorMessage(error),
          }),
        );
      });
      return true;
    },
    [createNew, handleNewThread, publishToGitHub],
  );
}

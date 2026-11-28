import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getNewProjectRepository,
  type NewProjectPublishTarget,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : m(msg("An error occurred."));
}

export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });

  const publishNewRepository = async (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly target: NewProjectPublishTarget;
  }) => {
    const { label } = input.target.definition;
    const result = await publishRepository({
      environmentId: input.environmentId,
      input: {
        cwd: input.workspaceRoot,
        provider: input.target.definition.kind,
        repository: getNewProjectRepository(input.target, input.workspaceRoot),
        visibility: "private",
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not create the {label} repository", { label })),
            description: m(
              msg("{error} Use Publish Repository in the Git menu to try again.", {
                error: errorMessage(squashAtomCommandFailure(result)),
              }),
            ),
          }),
        );
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: m(msg("Published to {label}", { label })),
        description: result.value.repository.nameWithOwner,
      }),
    );
    void suggestAppAccessForRemote(input.environmentId, result.value.remoteUrl);
  };

  return async (
    input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly publishTo: NewProjectPublishTarget | null;
    },
    openProject: (projectRef: ScopedProjectRef, project: EnvironmentProject) => Promise<void>,
  ): Promise<boolean> => {
    const result = await createNew({
      environmentId: input.environmentId,
      input: { name: input.name },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Could not create the project")),
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    }

    const { projectId, workspaceRoot, commitError } = result.value;
    toastManager.add(
      stackedThreadToast(
        commitError === undefined
          ? {
              type: "success",
              title: m(msg("Created {name}", { name: input.name })),
              description: workspaceRoot,
            }
          : {
              type: "warning",
              title: m(msg("Created {name} without a first commit", { name: input.name })),
              description: m(
                msg("{error} The project is in {path}.", {
                  error: commitError,
                  path: workspaceRoot,
                }),
              ),
            },
      ),
    );
    if (input.publishTo) {
      void publishNewRepository({
        environmentId: input.environmentId,
        workspaceRoot,
        target: input.publishTo,
      });
    }

    const projectRef = scopeProjectRef(input.environmentId, projectId);
    // Wait for the stored project path; drafts use it as their key.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to open project")),
          description: m(
            msg("{error} It will appear in the sidebar once this client catches up.", {
              error: errorMessage(error),
            }),
          ),
        }),
      );
      return null;
    });
    if (project === null) return true;
    await openProject(projectRef, project).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Failed to open project")),
          description: errorMessage(error),
        }),
      );
    });
    return true;
  };
}

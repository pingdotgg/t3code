import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
} from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { msg } from "gt-react";

import { handleDesktopAppActivationRequest } from "../desktopAppActivation";
import { m } from "../i18n/messages";
import { newProjectId } from "../lib/utils";
import { readProjects, waitForProject } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { localEnvironmentIdAtom } from "../state/primaryEnvironment";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentShellHasSnapshot } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Opens a folder on this computer as a project in this computer's environment: an
 * existing project opens (and unarchives), a new one is added. Used by `t3 <dir>`
 * activations and folders dropped on the sidebar. `ready` is false until that
 * environment's projects have loaded, so a known folder is not added twice.
 */
export function useOpenLocalWorkspace() {
  const localEnvironment = useEnvironment(useAtomValue(localEnvironmentIdAtom));
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });
  const openThread = useNewThreadHandler();
  const shellHasSnapshot = useEnvironmentShellHasSnapshot(localEnvironment?.environmentId ?? null);
  const ready =
    localEnvironment?.connection.phase === "connected" &&
    localEnvironment.serverConfig !== null &&
    shellHasSnapshot;

  const open = (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          localEnvironment?.connection.phase !== "connected" ||
          localEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: localEnvironment.environmentId,
          platform: localEnvironment.serverConfig.environment.platform.os,
        };
      },
      waitForSnapshot: async () => shellHasSnapshot,
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error
            ? error
            : new Error(m(msg("T3 Code could not add the project.")));
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => {
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === projectRef.environmentId &&
            candidate.id === projectRef.projectId,
        );
        // Opening an archived project's folder again brings the project back.
        if (project?.archivedAt != null) {
          void updateProject({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId, archived: false },
          }).then((result) => reportProjectFailure(m(msg("Failed to unarchive project")), result));
        }
        return openThread(projectRef);
      },
    });

  return { ready, open };
}

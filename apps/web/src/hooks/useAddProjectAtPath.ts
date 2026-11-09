import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  findExistingAddProject,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { getLatestThreadForProject } from "@t3tools/client-runtime/state/thread-sort";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { isSidebarHiddenThread } from "../components/Sidebar.logic";
import { newProjectId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { getClientSettings } from "./useSettings";

export interface AddProjectAtPathInput {
  readonly environmentId: EnvironmentId;
  readonly rawCwd: string;
  readonly platform: string;
  readonly currentProjectCwd: string | null;
  /** False once the caller no longer wants to land in the new project. */
  readonly isCurrent?: () => boolean;
}

function toastError(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

function errorDescription(error: unknown) {
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Adds the folder at a path as a project, or reopens the project already there,
 * then opens a thread in it. Resolves true once the user has landed somewhere.
 */
export function useAddProjectAtPath() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const handleNewThread = useNewThreadHandler();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "project unarchive",
  });

  return async (input: AddProjectAtPathInput): Promise<boolean> => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastError(
        "Environment unavailable",
        `${environment?.label ?? "The selected environment"} is not connected.`,
      );
      return false;
    }

    if (input.rawCwd.trim().length === 0) return false;
    const resolution = resolveAddProjectPath({
      rawPath: input.rawCwd,
      currentProjectCwd: input.currentProjectCwd,
      platform: input.platform,
    });
    if (!resolution.ok) {
      toastError("Failed to add project", resolution.error);
      return false;
    }
    const cwd = resolution.path;

    const existing = findExistingAddProject({
      projects: readProjects(),
      environmentId: input.environmentId,
      path: cwd,
    });
    if (existing) {
      // Adding an archived project's folder again brings the project back.
      if (existing.archivedAt != null) {
        void updateProject({
          environmentId: existing.environmentId,
          input: { projectId: existing.id, archived: false },
        }).then((result) => reportProjectFailure("Failed to unarchive project", result));
      }
      const latestThread = getLatestThreadForProject(
        appAtomRegistry
          .get(environmentThreadShells.visibleThreadShellsAtom)
          .filter(
            (thread) =>
              thread.environmentId === existing.environmentId && !isSidebarHiddenThread(thread),
          ),
        existing.id,
        getClientSettings().sidebarThreadSortOrder,
      );
      if (latestThread && latestThread.settledOverride !== "settled") {
        const navigationResult = await settlePromise(() =>
          navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(latestThread.environmentId, latestThread.id),
            ),
          }),
        );
        if (navigationResult._tag === "Failure") {
          toastError(
            "Failed to open project",
            errorDescription(squashAtomCommandFailure(navigationResult)),
          );
          return false;
        }
        return true;
      }
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
      );
      if (navigationResult._tag === "Failure") {
        toastError(
          "Failed to open project",
          errorDescription(squashAtomCommandFailure(navigationResult)),
        );
        return false;
      }
      return true;
    }

    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
      toastError("Cannot add project", "This connection cannot add projects.");
      return false;
    }
    const projectId = newProjectId();
    const createResult = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(cwd),
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (createResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(createResult)) {
        toastError(
          "Failed to add project",
          errorDescription(squashAtomCommandFailure(createResult)),
        );
      }
      return false;
    }

    if (input.isCurrent?.() === false) return false;
    const navigationResult = await settlePromise(() =>
      handleNewThread(scopeProjectRef(input.environmentId, projectId)),
    );
    if (navigationResult._tag === "Failure") {
      toastError(
        "Failed to add project",
        errorDescription(squashAtomCommandFailure(navigationResult)),
      );
      return false;
    }
    return true;
  };
}

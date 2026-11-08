import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "@t3tools/client-runtime/state/projects";
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
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";
import { reportProjectFailure } from "./useProjectGroupUpdate";
import { useClientSettings } from "./useSettings";

export interface AddProjectAtPathInput {
  readonly environmentId: EnvironmentId;
  readonly rawCwd: string;
  readonly platform: string;
  readonly currentProjectCwd: string | null;
}

export type AddProjectPathResolution =
  | { readonly kind: "path"; readonly cwd: string }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string };

export function resolveAddProjectPath(
  input: Pick<AddProjectAtPathInput, "rawCwd" | "platform" | "currentProjectCwd">,
): AddProjectPathResolution {
  const trimmed = input.rawCwd.trim();
  if (isUnsupportedWindowsProjectPath(trimmed, input.platform)) {
    return { kind: "invalid", message: "Windows-style paths are only supported on Windows." };
  }
  if (isExplicitRelativeProjectPath(trimmed) && !input.currentProjectCwd) {
    return { kind: "invalid", message: "Relative paths require an active project." };
  }
  const cwd = resolveProjectPathForDispatch(input.rawCwd, input.currentProjectCwd);
  return cwd.length === 0 ? { kind: "empty" } : { kind: "path", cwd };
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
  const projects = useProjects();
  const threads = useVisibleThreadShells().filter((thread) => !isSidebarHiddenThread(thread));
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
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

    const resolution = resolveAddProjectPath(input);
    if (resolution.kind === "invalid") {
      toastError("Failed to add project", resolution.message);
      return false;
    }
    if (resolution.kind === "empty") return false;
    const { cwd } = resolution;

    const existing = findProjectByPath(
      projects.filter((project) => project.environmentId === input.environmentId),
      cwd,
    );
    if (existing) {
      // Adding an archived project's folder again brings the project back.
      if (existing.archivedAt != null) {
        void updateProject({
          environmentId: existing.environmentId,
          input: { projectId: existing.id, archived: false },
        }).then((result) => reportProjectFailure("Failed to unarchive project", result));
      }
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === existing.environmentId),
        existing.id,
        sortOrder,
      );
      if (latestThread && latestThread.settledOverride !== "settled") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
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

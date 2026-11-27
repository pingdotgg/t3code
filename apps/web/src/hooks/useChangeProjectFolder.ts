import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  findProjectByPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectFolderChange,
} from "@t3tools/client-runtime/state/projects";
import { useGT } from "gt-react";

import { getEnvironmentBrowsePlatform } from "../components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readProjects } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportProjectFailure } from "./useProjectGroupUpdate";

/**
 * Points a project at another folder; its threads and settings stay with it. Resolves true
 * when the caller's picker should close: the folder changed, was already this one, or the
 * project is gone.
 */
export function useChangeProjectFolder() {
  const gt = useGT();
  const updateProjectFolder = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  return async (project: EnvironmentProject | null, rawCwd: string): Promise<boolean> => {
    const failureTitle = gt("Failed to change project folder");
    const fail = (description: string) =>
      toastManager.add(stackedThreadToast({ type: "error", title: failureTitle, description }));
    // The project can be removed while a picker is open; never add one in its place.
    if (project === null) {
      fail(gt("This project is no longer available."));
      return true;
    }
    const platform = getEnvironmentBrowsePlatform(
      readEnvironment(project.environmentId)?.serverConfig?.environment.platform.os,
    );
    if (isUnsupportedWindowsProjectPath(rawCwd.trim(), platform)) {
      fail(gt("Windows-style paths are only supported on Windows."));
      return false;
    }
    const cwd = resolveProjectFolderChange(rawCwd, project.workspaceRoot);
    if (cwd.length === 0) return false;
    if (findProjectByPath([project], cwd)) return true;
    const owner = findProjectByPath(
      readProjects().filter(
        (candidate) =>
          candidate.environmentId === project.environmentId && candidate.id !== project.id,
      ),
      cwd,
    );
    if (owner) {
      fail(gt('This folder already belongs to "{title}".', { title: owner.title }));
      return false;
    }
    const result = await updateProjectFolder({
      environmentId: project.environmentId,
      input: { projectId: project.id, workspaceRoot: cwd },
    });
    if (result._tag === "Failure") {
      reportProjectFailure(failureTitle, result);
      return false;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Project folder changed"),
        description: cwd,
      }),
    );
    return true;
  };
}

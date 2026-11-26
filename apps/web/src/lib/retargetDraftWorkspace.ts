import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef } from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";

import type { DraftSessionState } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShells } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { environmentSummaries } from "../state/presentation";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { peekT3ProjectFile } from "./t3ProjectFileDefaults";

function newThreadWorkspace(projectRef: ScopedProjectRef) {
  const project = readProject(projectRef);
  const serverConfig = readEnvironment(projectRef.environmentId)?.serverConfig;
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const consultProjectFile =
    project !== null &&
    resolveProjectSettings(settings, projectRef.projectId, project).settings
      .defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(projectRef.environmentId);
  const projectFile = consultProjectFile
    ? (peekT3ProjectFile(projectRef.environmentId, project.workspaceRoot) ?? null)
    : null;
  const projectSettings = resolveProjectSettings(
    settings,
    projectRef.projectId,
    project,
    projectFile,
  );
  const envMode = resolveNewThreadEnvMode({
    projectSettings,
    workspaceRoot: project?.workspaceRoot ?? null,
    newProjectsRoot: serverConfig?.newProjectsRoot,
    projectHasThreads:
      readThreadShells().some(
        (thread) =>
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      ) ||
      readUnloadedThreadCount(
        [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
        [],
      ) > 0,
  });
  return {
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
    }),
  };
}

/**
 * The workspace for a draft moving to another project or machine. One the draft only
 * inherited from its old project's defaults becomes the default a new thread there starts
 * with; one the user changed carries over.
 */
export function retargetDraftWorkspace(
  draft: Pick<
    DraftSessionState,
    "environmentId" | "projectId" | "envMode" | "startFromOrigin" | "worktreePath"
  >,
  projectRef: ScopedProjectRef,
): { envMode?: DraftSessionState["envMode"]; startFromOrigin?: boolean } {
  const inherited = newThreadWorkspace({
    environmentId: draft.environmentId,
    projectId: draft.projectId,
  });
  if (
    draft.worktreePath !== null ||
    draft.envMode !== inherited.envMode ||
    draft.startFromOrigin !== inherited.startFromOrigin
  )
    return {};
  return newThreadWorkspace(projectRef);
}

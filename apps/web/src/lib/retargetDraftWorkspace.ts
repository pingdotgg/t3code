import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ServerConfig,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { flushSync } from "react-dom";

import { type DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "../state/entities";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { peekT3ProjectFile, readT3ProjectFile } from "./t3ProjectFileDefaults";

interface PendingWorkspaceDefault {
  readonly projectRef: ScopedProjectRef;
  readonly envMode: DraftSessionState["envMode"];
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
}

const pendingWorkspaceDefaults = new Map<DraftId, PendingWorkspaceDefault>();

function keepsProvisionalWorkspace(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.environmentId === pending.projectRef.environmentId &&
    draft.projectId === pending.projectRef.projectId &&
    draft.envMode === pending.envMode &&
    draft.worktreePath === null &&
    !draft.workspaceExplicit &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<void> | null {
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!keepsProvisionalWorkspace(draft, pending)) return null;
  // A send may already be waiting when the draft moves again.
  return pending.settled.then(async () => {
    await readPendingWorkspaceDefault(draftId);
  });
}

function clearPendingWorkspaceDefault(draftId: DraftId): void {
  pendingWorkspaceDefaults.delete(draftId);
}

/** Resolve the workspace immediately, then register a cold file read after the draft is written. */
export function prepareDraftWorkspaceDefault(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | undefined,
  serverConfig: Pick<ServerConfig, "settings" | "newProjectsRoot"> | undefined,
) {
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const projectSettings = resolveProjectSettings(settings, project?.id ?? null, project);
  const workspaceFor = (projectFile: T3ProjectFile | null) => {
    const envMode = resolveNewThreadEnvMode({
      projectSettings: resolveProjectSettings(settings, project?.id ?? null, project, projectFile),
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
  };

  const consultProjectFile =
    project !== undefined &&
    projectSettings.settings.defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(projectRef.environmentId);
  const projectFile = consultProjectFile
    ? peekT3ProjectFile(projectRef.environmentId, project.workspaceRoot)
    : null;
  const workspace = workspaceFor(projectFile ?? null);
  if (!consultProjectFile || projectFile !== undefined) {
    return { workspace, applyProjectFile: clearPendingWorkspaceDefault };
  }

  return {
    workspace,
    applyProjectFile(draftId: DraftId) {
      const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
      const openedManual = getDraftSession(draftId)?.environmentSelection === "manual";
      const settled = readT3ProjectFile(projectRef.environmentId, project.workspaceRoot)
        .then((file) => {
          const draft = getDraftSession(draftId);
          if (
            file === null ||
            pendingWorkspaceDefaults.get(draftId) !== pending ||
            !keepsProvisionalWorkspace(draft, pending)
          )
            return;
          const resolved = workspaceFor(file);
          if (resolved.envMode === workspace.envMode) return;
          // Commit before a waiting send re-reads the composer's workspace.
          flushSync(() =>
            setDraftThreadContext(draftId, {
              envMode: resolved.envMode,
              ...(draft.startFromOrigin === workspace.startFromOrigin
                ? { startFromOrigin: resolved.startFromOrigin }
                : {}),
            }),
          );
        })
        .finally(() => {
          if (pendingWorkspaceDefaults.get(draftId) === pending) {
            clearPendingWorkspaceDefault(draftId);
          }
        });
      const pending = { projectRef, envMode: workspace.envMode, openedManual, settled };
      pendingWorkspaceDefaults.set(draftId, pending);
    },
  };
}

/**
 * The workspace for a draft moving to another project or machine: the default a new thread
 * there starts with, unless the user chose one, which carries over.
 */
export function retargetDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
) {
  return draft.workspaceExplicit || draft.worktreePath !== null
    ? { workspace: {}, applyProjectFile: clearPendingWorkspaceDefault }
    : prepareDraftWorkspaceDefault(
        projectRef,
        project,
        appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId),
      );
}

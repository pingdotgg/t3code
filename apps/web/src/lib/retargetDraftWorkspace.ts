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
import { readProject, readThreadShells } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { peekT3ProjectFile, readT3ProjectFile } from "./t3ProjectFileDefaults";

interface PendingWorkspaceDefault {
  readonly envMode: DraftSessionState["envMode"];
  readonly openedManual: boolean;
  readonly settled: Promise<void>;
  readonly superseded: PromiseWithResolvers<false>;
  readonly branchActions: Set<Promise<void>>;
}

// Keyed by draft, not project: load balancing moves a draft between machines of the same
// project without retargeting its workspace, and the file's default must still land.
const pendingWorkspaceDefaults = new Map<DraftId, PendingWorkspaceDefault>();
// Outlives a branch commit that drops the pending default, so a later move still stops a waiting send.
const unsettledDefaultReads = new Map<DraftId, PendingWorkspaceDefault["superseded"]>();

function keepsProvisionalWorkspace(
  draft: DraftSessionState | null,
  pending: PendingWorkspaceDefault,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    draft.envMode === pending.envMode &&
    draft.worktreePath === null &&
    !draft.workspaceExplicit &&
    (pending.openedManual || draft.environmentSelection !== "manual")
  );
}

/** Resolves false when the user moves the draft before the default lands, so the send stops. */
export function readPendingWorkspaceDefault(draftId: DraftId): Promise<boolean> | null {
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (!pending) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!keepsProvisionalWorkspace(draft, pending)) return null;
  return Promise.race([pending.settled.then(() => true), pending.superseded.promise]);
}

function clearPendingWorkspaceDefault(draftId: DraftId): void {
  pendingWorkspaceDefaults.delete(draftId);
}

export function dropPendingWorkspaceDefault(draftId: DraftId): void {
  unsettledDefaultReads.get(draftId)?.resolve(false);
  unsettledDefaultReads.delete(draftId);
  pendingWorkspaceDefaults.delete(draftId);
}

/** Hold a pending default until a manual branch action commits or finishes without a choice. */
export async function withDraftBranchChoice(
  draftId: DraftId | null,
  action: (commit: () => void) => Promise<void>,
): Promise<void> {
  const pending = draftId === null ? undefined : pendingWorkspaceDefaults.get(draftId);
  if (draftId === null || !pending) return action(() => {});
  const hold = Promise.withResolvers<void>();
  pending.branchActions.add(hold.promise);
  try {
    await action(() => {
      if (pendingWorkspaceDefaults.get(draftId) === pending) {
        clearPendingWorkspaceDefault(draftId);
      }
    });
  } finally {
    pending.branchActions.delete(hold.promise);
    hold.resolve();
  }
}

type WorkspaceServerConfig = Pick<ServerConfig, "settings" | "newProjectsRoot">;

function resolveDraftWorkspace(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | null | undefined,
  serverConfig: WorkspaceServerConfig | null | undefined,
  projectFile: T3ProjectFile | null,
) {
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    projectRef.projectId,
    project ?? null,
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

/** Resolve the workspace immediately, then register a cold file read after the draft is written. */
export function prepareDraftWorkspaceDefault(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | undefined,
  serverConfig: WorkspaceServerConfig | undefined,
) {
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const workspaceFor = (projectFile: T3ProjectFile | null) =>
    resolveDraftWorkspace(projectRef, project, serverConfig, projectFile);

  const consultProjectFile =
    project !== undefined &&
    resolveProjectSettings(settings, projectRef.projectId, project).settings
      .defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(projectRef.environmentId);
  const projectFile = consultProjectFile
    ? peekT3ProjectFile(projectRef.environmentId, project.workspaceRoot)
    : null;
  const workspace = workspaceFor(projectFile ?? null);
  if (!consultProjectFile || projectFile !== undefined) {
    return { workspace, applyProjectFile: dropPendingWorkspaceDefault };
  }

  return {
    workspace,
    applyProjectFile(draftId: DraftId) {
      const { getDraftSession, setDraftThreadContext } = useComposerDraftStore.getState();
      const openedManual = getDraftSession(draftId)?.environmentSelection === "manual";
      const branchActions = new Set<Promise<void>>();
      const settled = readT3ProjectFile(projectRef.environmentId, project.workspaceRoot)
        .then(async (file) => {
          if (file === null) return;
          while (pendingWorkspaceDefaults.get(draftId) === pending && branchActions.size > 0) {
            await Promise.all(branchActions);
          }
          const draft = getDraftSession(draftId);
          if (
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
          if (unsettledDefaultReads.get(draftId) === pending.superseded) {
            unsettledDefaultReads.delete(draftId);
          }
        });
      const pending = {
        envMode: workspace.envMode,
        openedManual,
        settled,
        superseded: Promise.withResolvers<false>(),
        branchActions,
      };
      dropPendingWorkspaceDefault(draftId);
      pendingWorkspaceDefaults.set(draftId, pending);
      unsettledDefaultReads.set(draftId, pending.superseded);
    },
  };
}

/** The workspace for a draft moved to another project, applied without waiting on its t3.json. */
export function retargetMovedDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
) {
  return draft.workspaceExplicit || draft.worktreePath !== null
    ? { workspace: {}, applyProjectFile: dropPendingWorkspaceDefault }
    : prepareDraftWorkspaceDefault(
        projectRef,
        project,
        appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId),
      );
}

async function newThreadWorkspace(projectRef: ScopedProjectRef, signal: AbortSignal) {
  let project = readProject(projectRef);
  let serverConfig = readEnvironment(projectRef.environmentId)?.serverConfig;
  let projectFile: T3ProjectFile | null = null;
  const workspaceRoot = project?.workspaceRoot;
  if (
    workspaceRoot &&
    resolveProjectSettings(
      serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      projectRef.projectId,
      project,
    ).settings.defaultThreadEnvMode === null
  ) {
    const cached = peekT3ProjectFile(projectRef.environmentId, workspaceRoot);
    if (cached === undefined) {
      // A paired project can appear before its connection summary reports connected.
      projectFile = await readT3ProjectFile(projectRef.environmentId, workspaceRoot, signal);
      project = readProject(projectRef);
      serverConfig = readEnvironment(projectRef.environmentId)?.serverConfig;
    } else {
      projectFile = cached;
    }
  }
  return resolveDraftWorkspace(projectRef, project, serverConfig, projectFile);
}

/**
 * The workspace for a draft moving to another machine, once the destination's t3.json is
 * read: the default a new thread there starts with, unless the user chose one, which carries over.
 */
export async function retargetDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  signal: AbortSignal,
): Promise<{ envMode?: DraftSessionState["envMode"]; startFromOrigin?: boolean }> {
  return draft.workspaceExplicit || draft.worktreePath !== null
    ? {}
    : newThreadWorkspace(projectRef, signal);
}

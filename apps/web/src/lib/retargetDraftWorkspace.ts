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
  readonly branchActions: Set<Promise<void>>;
  readonly finish: () => void;
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
  if (pending === undefined) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return keepsProvisionalWorkspace(draft, pending) ? pending.settled : null;
}

export function waitForPendingWorkspaceDefault(draftId: DraftId): Promise<void> | null {
  const pending = readPendingWorkspaceDefault(draftId);
  if (pending === null) return null;
  return (async () => {
    // A project move can replace the request while send is waiting.
    let current: Promise<void> | null = pending;
    while (current !== null) {
      await current;
      current = readPendingWorkspaceDefault(draftId);
    }
  })();
}

export function cancelPendingWorkspaceDefault(draftId: DraftId): void {
  const pending = pendingWorkspaceDefaults.get(draftId);
  pendingWorkspaceDefaults.delete(draftId);
  pending?.finish();
}

/** Keep the provisional workspace until a branch checkout has succeeded or failed. */
export function holdPendingWorkspaceDefault(draftId: DraftId) {
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (!pending) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  pending.branchActions.add(promise);
  return () => {
    pending.branchActions.delete(promise);
    resolve();
  };
}

function newThreadWorkspace(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | null | undefined,
  serverConfig: Pick<ServerConfig, "settings" | "newProjectsRoot"> | null | undefined,
  projectFile: T3ProjectFile | null,
) {
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
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

export function resolveDraftWorkspace(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | null | undefined,
  serverConfig: ServerConfig | undefined,
) {
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const resolveWorkspace = (projectFile: T3ProjectFile | null) =>
    newThreadWorkspace(projectRef, project, serverConfig, projectFile);

  // Disconnected environment queries wait for a connection.
  const workspaceRoot =
    project &&
    resolveProjectSettings(settings, projectRef.projectId, project).settings
      .defaultThreadEnvMode === null &&
    appAtomRegistry
      .get(environmentSummaries.connectedEnvironmentIdsAtom)
      .includes(projectRef.environmentId)
      ? project.workspaceRoot
      : null;
  const cachedFile =
    workspaceRoot === null ? null : peekT3ProjectFile(projectRef.environmentId, workspaceRoot);
  const workspace = resolveWorkspace(cachedFile ?? null);

  return {
    workspace,
    applyProjectFile(draftId: DraftId) {
      cancelPendingWorkspaceDefault(draftId);
      if (workspaceRoot === null || cachedFile !== undefined) return;
      const store = useComposerDraftStore.getState();
      const { promise, resolve } = Promise.withResolvers<void>();
      const pending: PendingWorkspaceDefault = {
        projectRef,
        envMode: workspace.envMode,
        openedManual: store.getDraftSession(draftId)?.environmentSelection === "manual",
        settled: promise,
        branchActions: new Set(),
        finish: () => {
          unsubscribe();
          resolve();
        },
      };
      if (!keepsProvisionalWorkspace(store.getDraftSession(draftId), pending)) return;
      const unsubscribe = useComposerDraftStore.subscribe((state) => {
        if (
          pendingWorkspaceDefaults.get(draftId) === pending &&
          !keepsProvisionalWorkspace(state.getDraftSession(draftId), pending)
        ) {
          cancelPendingWorkspaceDefault(draftId);
        }
      });
      pendingWorkspaceDefaults.set(draftId, pending);
      void readT3ProjectFile(projectRef.environmentId, workspaceRoot)
        .catch(() => null)
        .then(async (projectFile) => {
          while (
            pendingWorkspaceDefaults.get(draftId) === pending &&
            pending.branchActions.size > 0
          ) {
            await Promise.all(pending.branchActions);
          }
          if (pendingWorkspaceDefaults.get(draftId) !== pending) return;
          const draft = store.getDraftSession(draftId);
          if (!keepsProvisionalWorkspace(draft, pending)) return;
          const resolved = resolveWorkspace(projectFile);
          if (resolved.envMode === workspace.envMode) return;
          // Commit before a waiting send reads the composer's workspace.
          flushSync(() =>
            store.setDraftThreadContext(draftId, {
              envMode: resolved.envMode,
              ...(draft.startFromOrigin === workspace.startFromOrigin
                ? { startFromOrigin: resolved.startFromOrigin }
                : {}),
            }),
          );
        })
        .finally(() => {
          if (pendingWorkspaceDefaults.get(draftId) === pending) {
            cancelPendingWorkspaceDefault(draftId);
          }
        });
    },
  };
}

/**
 * The workspace for a draft moving to another project: the destination default, applied now and
 * corrected once an unread t3.json loads, unless the draft already has a chosen workspace.
 */
export function moveDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  project: EnvironmentProject | null,
) {
  return draft.workspaceExplicit || draft.worktreePath !== null
    ? { workspace: {}, applyProjectFile: cancelPendingWorkspaceDefault }
    : resolveDraftWorkspace(
        projectRef,
        project,
        appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId),
      );
}

function readWorkspaceContext(projectRef: ScopedProjectRef) {
  return {
    project: readProject(projectRef),
    serverConfig: appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId),
  };
}

/**
 * The workspace for a draft switching machine by hand: the destination default after its
 * t3.json is read, unless the user chose one, which carries over.
 */
export async function retargetDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  signal: AbortSignal,
): Promise<{ envMode?: DraftSessionState["envMode"]; startFromOrigin?: boolean }> {
  if (draft.workspaceExplicit || draft.worktreePath !== null) return {};
  let { project, serverConfig } = readWorkspaceContext(projectRef);
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
      ({ project, serverConfig } = readWorkspaceContext(projectRef));
    } else {
      projectFile = cached;
    }
  }
  return newThreadWorkspace(projectRef, project, serverConfig, projectFile);
}

// The board-host role: the whiteboard's run-t3.sh turns it on only where a hostname opens T3 as
// "app". Off everywhere else (any machine whose config maps no hostname to "app", and every
// non-whiteboard build), where nothing changes.
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { RightPanelMenuLayer, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "../../state/environments";
import {
  readProject,
  readThreadShell,
  useProject,
  useQuietThreadShell,
} from "../../state/entities";
import { primaryServerConfigAtom } from "../../state/server";
import { isBoardOffered } from "./boardChannel.logic";
import { isWhiteboardBuild } from "./build";

/** "unknown" until the primary server config arrives; `menu` is the machine's menu defaults. */
type BoardHostRole = "unknown" | "off" | { readonly menu: RightPanelMenuLayer };

const boardHostRoleAtom = Atom.make((get): BoardHostRole => {
  if (!isWhiteboardBuild) return "off";
  const config = get(primaryServerConfigAtom);
  if (config === null) return "unknown";
  return config.environment.capabilities.whiteboardPanel ?? "off";
}).pipe(Atom.withLabel("fork-board-host-role"));

export const useBoardHostRole = (): BoardHostRole => useAtomValue(boardHostRoleAtom);

const readBoardHostRole = (): BoardHostRole => appAtomRegistry.get(boardHostRoleAtom);

export const isBoardHost = (role: BoardHostRole): role is { readonly menu: RightPanelMenuLayer } =>
  typeof role === "object";

/** False inside the board page's chat slot, where the board already sits beside the chat. */
export const isTopWindow = (): boolean => window.parent === window;

/** Whether this thread may show the project's board in its right panel. */
export function boardOfferedFor(threadRef: ScopedThreadRef | null, projectRoot: string | null) {
  return isBoardOffered({
    boardHost: isBoardHost(readBoardHostRole()),
    topWindow: isTopWindow(),
    threadEnvironmentId: threadRef?.environmentId ?? null,
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    projectRoot,
  });
}

export function useBoardOfferedFor(threadRef: ScopedThreadRef | null, projectRoot: string | null) {
  return isBoardOffered({
    boardHost: isBoardHost(useBoardHostRole()),
    topWindow: isTopWindow(),
    threadEnvironmentId: threadRef?.environmentId ?? null,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
    projectRoot,
  });
}

/** The project's root, never a worktree path: one board per project, as `wb` and slot mode use. */
export function readThreadProjectRoot(threadRef: ScopedThreadRef): string | null {
  const projectId =
    readThreadShell(threadRef)?.projectId ??
    useComposerDraftStore.getState().getDraftSessionByRef(threadRef)?.projectId;
  if (projectId === undefined) return null;
  return readProject(scopeProjectRef(threadRef.environmentId, projectId))?.workspaceRoot ?? null;
}

export function useThreadProjectRoot(threadRef: ScopedThreadRef | null): string | null {
  const shellProjectId = useQuietThreadShell(threadRef)?.projectId;
  const draftProjectId = useComposerDraftStore((store) =>
    threadRef === null ? undefined : store.getDraftSessionByRef(threadRef)?.projectId,
  );
  const projectId = shellProjectId ?? draftProjectId;
  const project = useProject(
    threadRef === null || projectId === undefined
      ? null
      : scopeProjectRef(threadRef.environmentId, projectId),
  );
  return project?.workspaceRoot ?? null;
}

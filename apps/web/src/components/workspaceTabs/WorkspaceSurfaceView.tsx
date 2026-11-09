import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { lazy, Suspense } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { PersistentThreadTerminalPanel } from "../PersistentThreadTerminals";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import {
  fileTabKey,
  parseWorkspaceTab,
  terminalTabKey,
  useWorkspaceTabsStore,
} from "./workspaceTabsStore";

const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

function useThreadWorkspace(threadRef: ScopedThreadRef) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const thread = serverThread ?? draftThread;
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  return {
    project,
    workspaceRoot: thread?.worktreePath ?? project?.workspaceRoot ?? null,
  };
}

/** Opens a terminal tab for the routed thread, or null where no thread can own one. */
export function useNewTerminalTab(): (() => void) | null {
  const routeTarget = useThreadRouteTarget();
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalActions = useThreadTerminalActions(threadRef);
  if (!threadRef || !terminalActions.canWrite()) return null;
  const threadKey = scopedThreadKey(threadRef);
  return () =>
    void terminalActions.launchTerminal({
      place: (terminalId) =>
        useWorkspaceTabsStore.getState().showSurface(terminalTabKey(threadKey, terminalId)),
    })?.result;
}

function FileTab({ threadRef, path }: { threadRef: ScopedThreadRef; path: string }) {
  const { project, workspaceRoot } = useThreadWorkspace(threadRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const showSurface = useWorkspaceTabsStore((state) => state.showSurface);
  const draftId = useComposerDraftStore((store) => store.getDraftIdByRef(threadRef));
  if (!project || !workspaceRoot) return null;
  return (
    <Suspense fallback={null}>
      <FilePreviewPanel
        key={path}
        environmentId={threadRef.environmentId}
        cwd={workspaceRoot}
        projectName={project.title}
        projectId={project.id}
        threadRef={threadRef}
        composerDraftTarget={draftId ?? threadRef}
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInShortcutEnabled
        relativePath={path}
        revealLine={null}
        revealRequestId={0}
        onOpenFile={(relativePath) =>
          showSurface(fileTabKey(scopedThreadKey(threadRef), relativePath))
        }
        onNavigateFolder={() => undefined}
        folderTrail={undefined}
        onPendingChange={() => undefined}
        selectedFilePending={false}
        workspaceMutationId={null}
      />
    </Suspense>
  );
}

function TerminalTab({
  threadRef,
  terminalId,
}: {
  threadRef: ScopedThreadRef;
  terminalId: string;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminalActions = useThreadTerminalActions(threadRef);
  const showSurface = useWorkspaceTabsStore((state) => state.showSurface);
  const close = useWorkspaceTabsStore((state) => state.close);
  const threadKey = scopedThreadKey(threadRef);
  const openTerminalTab = () =>
    terminalActions.launchTerminal({
      place: (id) => showSurface(terminalTabKey(threadKey, id)),
    });
  return (
    <PersistentThreadTerminalPanel
      visible
      threadRef={threadRef}
      surface={{
        id: `terminal:${terminalId}`,
        kind: "terminal",
        resourceId: terminalId,
        terminalIds: [terminalId],
        activeTerminalId: terminalId,
      }}
      launchContext={null}
      keybindings={keybindings}
      onAddTerminalContext={() => undefined}
      onSplitTerminal={openTerminalTab}
      onSplitTerminalVertical={openTerminalTab}
      onNewTerminal={openTerminalTab}
      onActiveTerminalChange={() => undefined}
      onCloseTerminal={(id) => {
        terminalActions.closeTerminalSession(id);
        close(terminalTabKey(threadKey, id));
      }}
    />
  );
}

/** The open file or terminal tab, drawn over the routed thread like monocode's surface tabs. */
export function WorkspaceSurfaceView() {
  const surfaceKey = useWorkspaceTabsStore((state) => state.surfaceKey);
  const tab = surfaceKey ? parseWorkspaceTab(surfaceKey) : null;
  if (!tab || tab.kind === "thread") return null;
  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden bg-background md:rounded-lg md:border md:border-sidebar-border">
      {tab.kind === "file" ? (
        <FileTab threadRef={tab.threadRef} path={tab.path} />
      ) : (
        <TerminalTab threadRef={tab.threadRef} terminalId={tab.terminalId} />
      )}
    </div>
  );
}

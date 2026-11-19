import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "./composerDraftStore";
import { getClientSettings, subscribeClientSettings, useClientSettings } from "./hooks/useSettings";
import { projectPanelRef, setSharedPanelResolver } from "./panelScope";
import { useRightPanelStore } from "./rightPanelStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readThreadShell, useQuietThreadShell } from "./state/entities";
import { allEnvironmentShellsBootstrappedAtom } from "./state/shell";
import { useTerminalUiStateStore } from "./terminalUiStateStore";

// Worktree threads keep their own panel: a shared terminal would sit in another checkout.
function sharedPanelRef(
  enabled: boolean,
  ref: ScopedThreadRef,
  thread: { readonly projectId: ProjectId; readonly worktreePath: string | null } | null,
): ScopedThreadRef | null {
  if (!enabled || thread === null || thread.worktreePath !== null) return null;
  return projectPanelRef(ref.environmentId, thread.projectId);
}

/** The ref that owns `ref`'s right panel, terminal drawer and terminals. */
export function usePanelScopeRef(ref: ScopedThreadRef): ScopedThreadRef;
export function usePanelScopeRef(ref: ScopedThreadRef | null): ScopedThreadRef | null;
export function usePanelScopeRef(ref: ScopedThreadRef | null): ScopedThreadRef | null {
  const enabled = useClientSettings((settings) => settings.sharedProjectPanels);
  const serverThread = useQuietThreadShell(ref);
  const draftThread = useComposerDraftStore((store) =>
    ref ? store.getDraftThreadByRef(ref) : null,
  );
  if (ref === null) return null;
  return sharedPanelRef(enabled, ref, serverThread ?? draftThread) ?? ref;
}

export function startSharedProjectPanels(): void {
  setSharedPanelResolver((ref) =>
    sharedPanelRef(
      getClientSettings().sharedProjectPanels,
      ref,
      readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftThreadByRef(ref),
    ),
  );
  // Store selectors resolve the scope themselves, so they must run again when it can change.
  const rerunSelectors = () => {
    useRightPanelStore.setState({});
    useTerminalUiStateStore.setState({});
  };
  let enabled = getClientSettings().sharedProjectPanels;
  subscribeClientSettings(() => {
    const next = getClientSettings().sharedProjectPanels;
    if (next === enabled) return;
    enabled = next;
    rerunSelectors();
  });
  appAtomRegistry.subscribe(allEnvironmentShellsBootstrappedAtom, () => {
    if (enabled) rerunSelectors();
  });
}

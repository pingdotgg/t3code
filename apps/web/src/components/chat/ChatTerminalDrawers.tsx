import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { panelScopeKey } from "../../panelScope";
import { useThreadRefs } from "../../state/entities";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

interface ChatTerminalDrawersProps {
  readonly activeThreadKey: string | null;
  readonly activeTerminalOpen: boolean;
  readonly composerHeight: number;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly splitShortcutLabel: string | undefined;
  readonly splitVerticalShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

function drawerKeyOf(threadKey: string | null): string | null {
  const threadRef = threadKey === null ? null : parseScopedThreadKey(threadKey);
  return threadRef ? panelScopeKey(threadRef) : null;
}

/**
 * Keeps terminal drawers mounted for recently open threads, so switching back
 * to one finds its sessions as they were. Every thread's terminal and draft
 * state feeds the reconcile, so it subscribes here instead of in ChatView.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const { activeThreadKey } = props;
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = serverThreadRefs.map(scopedThreadKey);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = Object.values(draftThreadsByThreadKey).map((draftThread) =>
    scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
  );
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const activeTerminalDrawerPresence = usePanelPresence(
    Boolean(activeThreadKey && props.activeTerminalOpen),
    true,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const activeDrawerKey = drawerKeyOf(activeThreadKey);
  // One mounted thread per drawer, so threads sharing a drawer take one hidden slot.
  const mountedDrawerOwnerKeys = mountedTerminalThreadKeys.filter(
    (threadKey, index) =>
      threadKey === activeThreadKey ||
      (drawerKeyOf(threadKey) !== activeDrawerKey &&
        !mountedTerminalThreadKeys
          .slice(index + 1)
          .some((laterKey) => drawerKeyOf(laterKey) === drawerKeyOf(threadKey))),
  );
  const existingOpenTerminalThreadKeys = (() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    const openDrawerKeys = new Set(openTerminalThreadKeys);
    // Open state is stored under the drawer's key, which a shared drawer does not share with a thread.
    return mountedDrawerOwnerKeys.filter((threadKey) => {
      const drawerKey = drawerKeyOf(threadKey);
      return (
        existingThreadKeys.has(threadKey) && drawerKey !== null && openDrawerKeys.has(drawerKey)
      );
    });
  })();
  const reconciledMountedTerminalThreadKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedDrawerOwnerKeys,
    openThreadIds: existingOpenTerminalThreadKeys,
    activeThreadId: activeThreadKey,
    activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
    maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
  if (
    reconciledMountedTerminalThreadKeys.length !== mountedTerminalThreadKeys.length ||
    reconciledMountedTerminalThreadKeys.some(
      (threadKey, index) => threadKey !== mountedTerminalThreadKeys[index],
    )
  ) {
    setMountedTerminalThreadKeys(reconciledMountedTerminalThreadKeys);
  }
  // Threads sharing a project's drawer mount it once, keyed by its owner so it survives switching.
  const mountedDrawerKeys = new Set<string>();
  const mountedTerminalThreadRefs = [
    ...mountedTerminalThreadKeys.filter((threadKey) => threadKey === activeThreadKey),
    ...mountedTerminalThreadKeys.filter((threadKey) => threadKey !== activeThreadKey),
  ].flatMap((mountedThreadKey) => {
    const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
    if (!mountedThreadRef) return [];
    const drawerKey = panelScopeKey(mountedThreadRef);
    if (mountedDrawerKeys.has(drawerKey)) return [];
    mountedDrawerKeys.add(drawerKey);
    return [{ key: mountedThreadKey, drawerKey, threadRef: mountedThreadRef }];
  });

  return mountedTerminalThreadRefs.map(
    ({ key: mountedThreadKey, drawerKey, threadRef: mountedThreadRef }) => (
      <PersistentThreadTerminalDrawer
        key={drawerKey}
        threadRef={mountedThreadRef}
        active={mountedThreadKey === activeThreadKey}
        composerHeight={mountedThreadKey === activeThreadKey ? props.composerHeight : 0}
        launchContext={mountedThreadKey === activeThreadKey ? props.launchContext : null}
        splitShortcutLabel={props.splitShortcutLabel}
        splitVerticalShortcutLabel={props.splitVerticalShortcutLabel}
        newShortcutLabel={props.newShortcutLabel}
        closeShortcutLabel={props.closeShortcutLabel}
        keybindings={props.keybindings}
        onAddTerminalContext={props.onAddTerminalContext}
      />
    ),
  );
}

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { useThreadRefs } from "../../state/entities";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import type { PersistentTerminalLaunchContext } from "../PersistentThreadTerminals";

import { loadTerminalPanel } from "./panelModules";
import { loadCommandPaletteDialog } from "../../commandPaletteModule";
import { idleAfterPaint } from "../../lib/idleAfterPaint";

let loadedTerminalDrawer:
  | typeof import("../PersistentThreadTerminals").PersistentThreadTerminalDrawer
  | undefined;
const loadTerminalDrawer = () =>
  loadTerminalPanel().then((module) => {
    void module.preloadTerminalSymbolsFont();
    loadedTerminalDrawer = module.PersistentThreadTerminalDrawer;
    return module.PersistentThreadTerminalDrawer;
  });

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

/**
 * Keeps terminal drawers mounted for recently open threads, so switching back
 * to one finds its sessions as they were. Every thread's terminal and draft
 * state feeds the reconcile, so it subscribes here instead of in ChatView.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const [TerminalDrawer, setTerminalDrawer] = useState(() => loadedTerminalDrawer);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- This mounts with the thread shell; preload closed features only after that shell paints.
  useEffect(() => {
    let active = true;
    const cancel = idleAfterPaint(() => {
      void loadTerminalDrawer().then(
        (Drawer) => {
          if (active) setTerminalDrawer(() => Drawer);
        },
        () => {},
      );
      void loadCommandPaletteDialog().catch(() => {});
    });
    return () => {
      active = false;
      cancel();
    };
  }, []);
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
  const existingOpenTerminalThreadKeys = (() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  })();
  const reconciledMountedTerminalThreadKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedTerminalThreadKeys,
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
  // Prepare metadata at idle without creating a surface or attaching a session.
  const preparedThreadKeys =
    activeThreadKey && !mountedTerminalThreadKeys.includes(activeThreadKey)
      ? [...mountedTerminalThreadKeys, activeThreadKey]
      : mountedTerminalThreadKeys;
  const preparedTerminalThreadRefs = preparedThreadKeys.flatMap((mountedThreadKey) => {
    const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
    return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
  });

  const needsDrawer = mountedTerminalThreadKeys.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- An explicit open loads the drawer when it precedes optional idle preloading.
  useEffect(() => {
    if (!needsDrawer || TerminalDrawer) return;
    let active = true;
    void loadTerminalDrawer().then(
      (Drawer) => {
        if (active) setTerminalDrawer(() => Drawer);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [needsDrawer, TerminalDrawer]);

  if (!TerminalDrawer) return null;

  return preparedTerminalThreadRefs.map(
    ({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
      <TerminalDrawer
        key={mountedThreadKey}
        threadRef={mountedThreadRef}
        threadId={mountedThreadRef.threadId}
        active={
          mountedThreadKey === activeThreadKey &&
          mountedTerminalThreadKeys.includes(mountedThreadKey)
        }
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

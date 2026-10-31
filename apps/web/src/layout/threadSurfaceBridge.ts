/** Surface tabs work without an open chat. Workspace refreshes and composer actions become available
 * through this bridge only while that chat is mounted. */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { PersistentTerminalLaunchContext } from "../components/ThreadTerminalSurfaces";
import type { ComposerImageAttachment } from "../composerDraftStore";
import type { TerminalContextSelection } from "../lib/terminalContext";

export interface ThreadChatBridge {
  readonly workspaceMutationId: string | null;
  /** The chat can send now (not loading, connecting or mid-send). */
  readonly sendReady: boolean;
  readonly sendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Where the thread's terminal starts a session the chat asked for (a project script). */
  readonly terminalLaunchContext: PersistentTerminalLaunchContext | null;
}

export const useThreadChatBridgeStore = create<{
  byThreadKey: Readonly<Record<string, ThreadChatBridge>>;
}>(() => ({ byThreadKey: {} }));

/** A chat publishes its bridge while mounted; returns the unpublish. */
export function publishThreadChatBridge(
  threadRef: ScopedThreadRef,
  bridge: ThreadChatBridge,
): () => void {
  const key = scopedThreadKey(threadRef);
  useThreadChatBridgeStore.setState((state) => ({
    byThreadKey: { ...state.byThreadKey, [key]: bridge },
  }));
  return () =>
    useThreadChatBridgeStore.setState((state) => {
      if (state.byThreadKey[key] !== bridge) return state;
      const { [key]: _removed, ...rest } = state.byThreadKey;
      return { byThreadKey: rest };
    });
}

export function useThreadChatBridge(threadRef: ScopedThreadRef): ThreadChatBridge | null {
  const key = scopedThreadKey(threadRef);
  return useThreadChatBridgeStore((state) => state.byThreadKey[key] ?? null);
}

/**
 * The thread's chat bridge once its chat can send, or null if none is ready
 * within `timeoutMs` (the chat never opened, or stayed busy).
 */
export function waitForThreadChatSendReady(
  threadRef: ScopedThreadRef,
  timeoutMs: number,
): Promise<ThreadChatBridge | null> {
  const key = scopedThreadKey(threadRef);
  const ready = () => {
    const bridge = useThreadChatBridgeStore.getState().byThreadKey[key];
    return bridge?.sendReady ? bridge : null;
  };
  const now = ready();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (bridge: ThreadChatBridge | null) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(bridge);
    };
    const unsubscribe = useThreadChatBridgeStore.subscribe(() => {
      const bridge = ready();
      if (bridge) finish(bridge);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import type { RightPanelSurface } from "../rightPanelStore";
import { resolveFocusedSideChat, useSideChatFocusStore } from "../sideChatStore";
import { useSideChatActions } from "./useSideChatActions";
import { useStableCallback } from "./useStableCallback";

/**
 * A thread's side of its side chats: the actions, which side chat its composer
 * talks to, and the slot that side chat's composer renders in.
 */
export function useSideChatHost(input: {
  /** Null for drafts and inside a side chat, which has none of its own. */
  readonly threadRef: ScopedThreadRef | null;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly panelOpen: boolean;
  readonly activeSurface: RightPanelSurface | null;
  /** The panel sits beside this thread's column, where the side chat's composer goes. */
  readonly panelBesideColumn: boolean;
}) {
  const { threadRef, composerRef } = input;
  const actions = useSideChatActions(threadRef);
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const picked = useSideChatFocusStore((state) =>
    threadKey === null ? null : (state.byParent[threadKey] ?? null),
  );
  const focusedSideChatId = resolveFocusedSideChat({
    picked,
    panelOpen: input.panelOpen,
    activeSurface: input.activeSurface,
  });
  // The side chat's composer, so keys typed or pasted anywhere in this thread
  // go where the user is talking.
  const sideComposerRef = useRef<ChatComposerHandle | null>(null);
  const [composerSlot, setComposerSlot] = useState<HTMLDivElement | null>(null);

  // Back from a side chat, this thread's composer takes the keyboard again.
  const hadFocusedSideChat = useRef(false);
  useEffect(() => {
    if (focusedSideChatId === null && hadFocusedSideChat.current) {
      composerRef.current?.focusAtEnd();
    }
    hadFocusedSideChat.current = focusedSideChatId !== null;
  }, [composerRef, focusedSideChatId]);

  const start = actions.start;
  const threadId = threadRef?.threadId ?? null;
  const onAskAboutResponse = useStableCallback(
    async (target: { readonly sourceThreadId: ThreadId; readonly runId: RunId }) => {
      if (target.sourceThreadId !== threadId) return;
      await start({ history: "with", runId: target.runId });
    },
  );
  const defaultHistory = actions.defaultHistory;
  // False keeps the selection for a retry while another side chat is still starting.
  const onAskAssistantText = useStableCallback((citation: AssistantCitation) => {
    if (!actions.canStart()) return false;
    void start({ history: defaultHistory, quote: citation.text });
    return true;
  });

  return {
    actions,
    available: actions.supported && threadRef !== null,
    focusedSideChatId,
    sideComposerRef,
    composerSlot: input.panelBesideColumn ? composerSlot : null,
    setComposerSlot,
    onAskAboutResponse,
    onAskAssistantText,
  };
}

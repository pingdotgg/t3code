import type { ModelSelection, RuntimeMode, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/** `prompt` is sent as the first message; `draft` waits in the side chat's composer. */
interface SideChatSeed {
  readonly prompt?: string;
  readonly draft?: string;
}

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, applies the seed there with `readSettings()`, the parent
 * composer's settings, and shows the tab. It resolves false when the side chat did not
 * start, or another one is still starting.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };
  const start = async (threadRef: ScopedThreadRef, seed: SideChatSeed) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return false;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
    if (!(await waitForThreadShell(targetRef))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard();
      return false;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      input.onError("The side chat is no longer available.");
      discard();
      return false;
    }
    if (runtimeMode !== sideChat.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        reportFailure(mode, "Could not set the side chat's permission mode.");
        discard();
        return false;
      }
    }
    const text = seed.prompt?.trim();
    if (seed.draft) {
      useComposerDraftStore.getState().setPrompt(targetRef, seed.draft);
    }
    // Send before showing the tab: closing a tab whose side chat has no run deletes it.
    if (text) {
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          ...(modelSelection === undefined ? {} : { modelSelection }),
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure") {
        reportFailure(turn, "Could not send the side chat message.");
        discard();
        return false;
      }
    } else if (modelSelection !== undefined) {
      useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
    if (seed.draft) {
      requestWorkspaceFocus({
        area: "panel",
        selector: `[data-side-chat-pane="${targetThreadId}"] [data-testid="composer-editor"]`,
      });
    }
    return true;
  };
  const open = async (seed: SideChatSeed = {}) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, seed).finally(() => {
      pendingRef.current = false;
    });
  };
  return { available: input.threadRef !== null, open: useStableCallback(open) };
}

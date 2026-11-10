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
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * `open` forks `threadRef` (none when null), sends `prompt` with `readSettings()` and shows the
 * tab, resolving false when it did not start or another is starting. `bind` captures the thread
 * and settings now for a send that opens the side chat later, wherever the composer is by then.
 */
type SideChatSource = {
  readonly threadRef: ScopedThreadRef;
  readonly settings: {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
};

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
  const start = async (
    { threadRef, settings, onError }: SideChatSource,
    prompt: string | undefined,
  ) => {
    const reportFailure = (
      failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
      fallback: string,
    ) => {
      if (isAtomCommandInterrupted(failure)) return;
      const error = squashAtomCommandFailure(failure);
      onError(error instanceof Error ? error.message : fallback);
    };
    const { runtimeMode, modelSelection } = settings;
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
      onError("The side chat was created, but it did not reach this client.");
      discard();
      return false;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      onError("The side chat is no longer available.");
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
    const text = prompt?.trim();
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
    return true;
  };
  const run = async (source: SideChatSource | null, prompt?: string) => {
    if (!source || pendingRef.current) return false;
    pendingRef.current = true;
    return start(source, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  const capture = (): SideChatSource | null =>
    input.threadRef
      ? { threadRef: input.threadRef, settings: input.readSettings(), onError: input.onError }
      : null;
  const bind = () => {
    const source = capture();
    return (prompt: string) => run(source, prompt);
  };
  return {
    available: input.threadRef !== null,
    open: useStableCallback((prompt?: string) => run(capture(), prompt)),
    bind: useStableCallback(bind),
  };
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveSideChatHistoryAvailability } from "@t3tools/client-runtime/state/thread-workflows";
import type { RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { newMessageId, newThreadId } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { isEmptySideChat, quoteForSideChat, sideChatsOf } from "../sideChat.logic";
import { useSideChatPreferenceStore, type SideChatHistoryChoice } from "../sideChatStore";
import {
  useEnvironmentSupportsSideChats,
  useThreadProjection,
  waitForThreadShell,
} from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** A side chat asks before changing files, so it is safe next to a running parent. */
export const SIDE_CHAT_READ_ONLY_RUNTIME_MODE = "approval-required" as const;
/** "Allow edits" still asks before commands, unlike the parent's full access. */
export const SIDE_CHAT_EDITABLE_RUNTIME_MODE = "auto-accept-edits" as const;

export interface StartSideChatInput {
  readonly history: SideChatHistoryChoice;
  /** A selection to quote; it lands in the side chat's composer for the user to finish. */
  readonly quote?: string;
  /** Sent immediately, after the quote when there is one. */
  readonly question?: string;
  /** Fork at this run instead of the latest stable one. */
  readonly runId?: RunId;
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Start, reopen, and resolve the side chats of one thread. A side chat is an
 * ordinary thread with `sideChat` set; these actions only choose how it is
 * created and where it shows up.
 */
export function useSideChatActions(parentRef: ScopedThreadRef | null) {
  const environmentId = parentRef?.environmentId ?? null;
  const supported = useEnvironmentSupportsSideChats(environmentId);
  const projection = useThreadProjection(parentRef)?.projection ?? null;
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });

  const historyAvailability = resolveSideChatHistoryAvailability(projection);
  // Read at click time on purpose: subscribing here would re-render the chat
  // view on every thread update anywhere.
  const readSideChats = useCallback(() => {
    if (parentRef === null) return [];
    return sideChatsOf(
      appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .filter((thread) => thread.environmentId === parentRef.environmentId),
      parentRef.threadId,
    );
  }, [parentRef]);

  const closeSurface = useCallback(
    (childThreadId: ThreadId) => {
      if (parentRef === null) return;
      useRightPanelStore.getState().closeSurface(parentRef, `aside:${childThreadId}`);
    },
    [parentRef],
  );

  const open = useCallback(
    (childThreadId: ThreadId) => {
      if (parentRef === null) return;
      useRightPanelStore.getState().openAside(parentRef, childThreadId);
    },
    [parentRef],
  );

  const start = useCallback(
    async (input: StartSideChatInput): Promise<ScopedThreadRef | null> => {
      if (parentRef === null || projection === null || !supported) return null;
      const parent = projection.thread;
      const childThreadId = newThreadId();
      const childRef = scopeThreadRef(parentRef.environmentId, childThreadId);
      const title = `${parent.title} side chat`;
      const created =
        input.history === "with"
          ? await forkFromRun({
              environmentId: parentRef.environmentId,
              input: {
                sourceThreadId: parentRef.threadId,
                targetThreadId: childThreadId,
                ...(input.runId === undefined ? {} : { runId: input.runId }),
                title,
                sideChat: true,
                runtimeMode: SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
              },
            })
          : await createThread({
              environmentId: parentRef.environmentId,
              input: {
                threadId: childThreadId,
                projectId: parent.projectId,
                title,
                modelSelection: parent.modelSelection,
                runtimeMode: SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
                interactionMode: "default",
                branch: parent.branch,
                worktreePath: parent.worktreePath,
                parentThreadId: parentRef.threadId,
                sideChat: true,
              },
            });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created)) {
          reportFailure("Could not start a side chat", squashAtomCommandFailure(created));
        }
        return null;
      }
      if (!(await waitForThreadShell(childRef))) {
        reportFailure(
          "Side chat not ready",
          new Error("It was created, but its data did not reach this client yet."),
        );
        return null;
      }
      useRightPanelStore.getState().openAside(parentRef, childThreadId);
      const question = input.question?.trim() ?? "";
      const quote = input.quote === undefined ? "" : quoteForSideChat(input.quote);
      if (question.length > 0) {
        const sent = await startTurn({
          environmentId: parentRef.environmentId,
          input: {
            threadId: childThreadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: `${quote}${question}`,
              attachments: [],
            },
            titleSeed: question.slice(0, 80),
            runtimeMode: SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
            interactionMode: "default",
            dispatchMode: "auto",
          },
        });
        if (sent._tag === "Failure" && !isAtomCommandInterrupted(sent)) {
          reportFailure("Could not send the question", squashAtomCommandFailure(sent));
        }
      } else if (quote.length > 0) {
        useComposerDraftStore.getState().setPrompt(childRef, quote);
      }
      return childRef;
    },
    [createThread, forkFromRun, parentRef, projection, startTurn, supported],
  );

  const reopenLatest = useCallback((): boolean => {
    const latest = readSideChats()[0];
    if (latest === undefined) return false;
    open(latest.id);
    return true;
  }, [open, readSideChats]);

  const lastHistoryChoice = useSideChatPreferenceStore((state) => state.history);
  const rememberHistoryChoice = useSideChatPreferenceStore((state) => state.setHistory);
  // The remembered choice, unless this thread cannot share history right now.
  const defaultHistory: SideChatHistoryChoice =
    lastHistoryChoice === "with" && historyAvailability.available ? "with" : "without";

  /**
   * `/side`, its keybinding and the palette entry: a question starts a side
   * chat and sends it, the bare command reopens the latest or starts one.
   */
  const run = useCallback(
    async (question: string) => {
      if (question.length === 0 && reopenLatest()) return;
      await start({ history: defaultHistory, ...(question ? { question } : {}) });
    },
    [defaultHistory, reopenLatest, start],
  );

  const setAllowEdits = useCallback(
    async (childThreadId: ThreadId, allow: boolean) => {
      if (parentRef === null) return;
      const result = await setRuntimeMode({
        environmentId: parentRef.environmentId,
        input: {
          threadId: childThreadId,
          runtimeMode: allow ? SIDE_CHAT_EDITABLE_RUNTIME_MODE : SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not change edit access", squashAtomCommandFailure(result));
      }
    },
    [parentRef, setRuntimeMode],
  );

  const discard = useCallback(
    async (childThreadId: ThreadId) => {
      if (parentRef === null) return;
      closeSurface(childThreadId);
      const result = await deleteThread({
        environmentId: parentRef.environmentId,
        input: { threadId: childThreadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not discard the side chat", squashAtomCommandFailure(result));
      }
    },
    [closeSurface, deleteThread, parentRef],
  );

  /** Closing a side chat that never got a message throws it away; otherwise it stays listed. */
  const close = useCallback(
    async (childThreadId: ThreadId) => {
      const shell = readSideChats().find((thread) => thread.id === childThreadId);
      if (shell !== undefined && isEmptySideChat(shell)) {
        await discard(childThreadId);
        return;
      }
      closeSurface(childThreadId);
    },
    [closeSurface, discard, readSideChats],
  );

  /** Clears the flag, so the thread joins the sidebar as an ordinary one. */
  const promote = useCallback(
    async (childThreadId: ThreadId) => {
      if (parentRef === null) return false;
      const result = await updateMetadata({
        environmentId: parentRef.environmentId,
        input: { threadId: childThreadId, sideChat: false },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not promote the side chat", squashAtomCommandFailure(result));
        }
        return false;
      }
      closeSurface(childThreadId);
      return true;
    },
    [closeSurface, parentRef, updateMetadata],
  );

  const bringBack = useCallback(
    async (childThreadId: ThreadId, runId: RunId) => {
      if (parentRef === null) return false;
      const result = await mergeBack({
        environmentId: parentRef.environmentId,
        input: { sourceThreadId: childThreadId, targetThreadId: parentRef.threadId, runId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not bring the side chat back", squashAtomCommandFailure(result));
        }
        return false;
      }
      toastManager.add({
        type: "success",
        title: "Brought back to main",
        description: "It goes in with your next message.",
      });
      return true;
    },
    [mergeBack, parentRef],
  );

  return {
    supported,
    historyAvailability,
    start,
    run,
    defaultHistory,
    open,
    reopenLatest,
    close,
    closeSurface,
    setAllowEdits,
    discard,
    promote,
    bringBack,
    lastHistoryChoice,
    rememberHistoryChoice,
  };
}

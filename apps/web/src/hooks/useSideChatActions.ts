import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveSideChatHistoryAvailability } from "@t3tools/client-runtime/state/thread-workflows";
import type { RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { newMessageId, newThreadId } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { isEmptySideChat, quoteForSideChat, sideChatsOf } from "../sideChat.logic";
import {
  useSideChatFocusStore,
  useSideChatPreferenceStore,
  type SideChatHistoryChoice,
} from "../sideChatStore";
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
const SIDE_CHAT_READ_ONLY_RUNTIME_MODE = "approval-required" as const;
/** "Allow edits" still asks before commands, unlike the parent's full access. */
const SIDE_CHAT_EDITABLE_RUNTIME_MODE = "auto-accept-edits" as const;

export interface StartSideChatInput {
  readonly history: SideChatHistoryChoice;
  /** A selection to quote; it lands in the side chat's composer for the user to finish. */
  readonly quote?: string;
  /** Sent immediately, after the quote when there is one. */
  readonly question?: string;
  /** Fork at this run instead of the latest stable one. */
  readonly runId?: RunId;
}

// Parent threads with a side chat being created. Module-level so every caller
// (keybinding, palette, selection Ask, `/side`) shares one guard per parent.
const startingSideChatFor = new Set<string>();

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
      useSideChatFocusStore.getState().release(scopedThreadKey(parentRef), childThreadId);
    },
    [parentRef],
  );

  const open = useCallback(
    (childThreadId: ThreadId) => {
      if (parentRef === null) return;
      useRightPanelStore.getState().openAside(parentRef, childThreadId);
      useSideChatFocusStore.getState().focus(scopedThreadKey(parentRef), childThreadId);
    },
    [parentRef],
  );

  const startSideChat = useCallback(
    async (
      ownerRef: ScopedThreadRef,
      parent: NonNullable<typeof projection>["thread"],
      input: StartSideChatInput,
    ): Promise<ScopedThreadRef | null> => {
      const childThreadId = newThreadId();
      const childRef = scopeThreadRef(ownerRef.environmentId, childThreadId);
      const title = "Side chat";
      const created =
        input.history === "with"
          ? await forkFromRun({
              environmentId: ownerRef.environmentId,
              input: {
                sourceThreadId: ownerRef.threadId,
                targetThreadId: childThreadId,
                ...(input.runId === undefined ? {} : { runId: input.runId }),
                title,
                sideChat: true,
                runtimeMode: SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
              },
            })
          : await createThread({
              environmentId: ownerRef.environmentId,
              input: {
                threadId: childThreadId,
                projectId: parent.projectId,
                title,
                modelSelection: parent.modelSelection,
                runtimeMode: SIDE_CHAT_READ_ONLY_RUNTIME_MODE,
                interactionMode: "default",
                branch: parent.branch,
                worktreePath: parent.worktreePath,
                parentThreadId: ownerRef.threadId,
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
      useRightPanelStore.getState().openAside(ownerRef, childThreadId);
      // The thread's composer talks to the side chat until Escape.
      useSideChatFocusStore.getState().focus(scopedThreadKey(ownerRef), childThreadId);
      const question = input.question?.trim() ?? "";
      const quote = input.quote === undefined ? "" : quoteForSideChat(input.quote);
      if (question.length > 0) {
        const sent = await startTurn({
          environmentId: ownerRef.environmentId,
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
        if (sent._tag === "Failure") {
          // Keep the question in the side chat so it can be sent again.
          useComposerDraftStore.getState().setPrompt(childRef, `${quote}${question}`);
          if (!isAtomCommandInterrupted(sent)) {
            reportFailure("Could not send the question", squashAtomCommandFailure(sent));
          }
        }
      } else if (quote.length > 0) {
        useComposerDraftStore.getState().setPrompt(childRef, quote);
      }
      return childRef;
    },
    [createThread, forkFromRun, startTurn],
  );

  // Read at call time: depending on the projection would replace `start` (and
  // the timeline callbacks built on it) on every streamed update.
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const start = useCallback(
    async (input: StartSideChatInput): Promise<ScopedThreadRef | null> => {
      const projection = projectionRef.current;
      if (parentRef === null || projection === null || !supported) return null;
      const parentKey = scopedThreadKey(parentRef);
      // A second press while the first fork is in flight would create a second side chat.
      if (startingSideChatFor.has(parentKey)) return null;
      startingSideChatFor.add(parentKey);
      try {
        return await startSideChat(parentRef, projection.thread, input);
      } finally {
        startingSideChatFor.delete(parentKey);
      }
    },
    [parentRef, startSideChat, supported],
  );

  const reopenLatest = useCallback((): boolean => {
    const latest = readSideChats()[0];
    if (latest === undefined) return false;
    open(latest.id);
    return true;
  }, [open, readSideChats]);

  const lastHistoryChoice = useSideChatPreferenceStore((state) => state.history);
  const rememberHistoryChoice = useSideChatPreferenceStore((state) => state.setHistory);
  // `/side`, the keybinding, the palette and selection Ask are questions about
  // this thread, so they share its history whenever they can. Only the `+`
  // button remembers a "without history" pick.
  const defaultHistory: SideChatHistoryChoice = historyAvailability.available ? "with" : "without";

  /**
   * `/side`, its keybinding and the palette entry: a question starts a side
   * chat and sends it, the bare command reopens the latest or starts one.
   * Resolves false when no side chat could be opened.
   */
  const run = useCallback(
    async (question: string): Promise<boolean> => {
      if (question.length === 0 && reopenLatest()) return true;
      const childRef = await start({ history: defaultHistory, ...(question ? { question } : {}) });
      return childRef !== null;
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
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not change edit access", squashAtomCommandFailure(result));
        }
        return;
      }
      // The composer's own permission pick outranks the thread's mode on the
      // next send, so drop it and let the switch decide.
      useComposerDraftStore
        .getState()
        .setRuntimeMode(scopeThreadRef(parentRef.environmentId, childThreadId), null);
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
      closeSurface(childThreadId);
      const shell = readSideChats().find((thread) => thread.id === childThreadId);
      if (parentRef === null || shell === undefined || !isEmptySideChat(shell)) return;
      // This client's copy can lag a question that already landed, so the
      // server deletes only if the thread is still empty. If not, it stays listed.
      await deleteThread({
        environmentId: parentRef.environmentId,
        input: { threadId: childThreadId, expectedEmpty: true },
      });
    },
    [closeSurface, deleteThread, parentRef, readSideChats],
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

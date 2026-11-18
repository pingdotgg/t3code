import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, type RefObject } from "react";

import type { ComposerPromptEditorHandle } from "../../components/ComposerPromptEditorTiptap";
import { useInSubThreadView } from "../subThreads/subThreadsState";
import { registerBoardComposer } from "./boardChannel";
import { isEmbeddedInWhiteboard } from "./build";
import { isBoardHost, isTopWindow, useBoardHostRole } from "./role";

// The board sends the reference of a region the user picked; it lands at the caret as its own word.
export function useWhiteboardInsertRef(
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
  promptRef: RefObject<string>,
  applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: { focusEditorAfterReplace?: boolean },
  ) => unknown,
  rootRef: RefObject<HTMLElement | null>,
  threadRef: ScopedThreadRef,
) {
  const inSubThreadView = useInSubThreadView();
  const threadKey = scopedThreadKey(threadRef);
  const boardHost = isBoardHost(useBoardHostRole());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the board's insert requests (slot mode) or registers this composer with the board channel (panel mode) while mounted
  useEffect(() => {
    const insert = (ref: string, focus: boolean) => {
      const snapshot = editorRef.current?.readSnapshot();
      const cursor =
        snapshot?.value === promptRef.current ? snapshot.expandedCursor : promptRef.current.length;
      const spaced =
        cursor > 0 && !/\s/.test(promptRef.current[cursor - 1] ?? "") ? ` ${ref}` : ref;
      return (
        applyPromptReplacement(cursor, cursor, `${spaced} `, { focusEditorAfterReplace: focus }) ===
        true
      );
    };
    if (isEmbeddedInWhiteboard()) {
      const insertWhiteboardRef = (event: MessageEvent) => {
        const { type, ref } = (event.data ?? {}) as { type?: string; ref?: string };
        if (event.source !== window.parent || type !== "wb-insert-ref" || !ref) return;
        // With a sub-thread open, the thread has two composers. The one that has focus, or had it
        // before the user went to the board, takes the reference.
        const focusInSubThread = document.activeElement?.closest("[data-sub-thread-view]") != null;
        if (focusInSubThread !== inSubThreadView) return;
        void insert(ref, true);
      };
      window.addEventListener("message", insertWhiteboardRef);
      return () => window.removeEventListener("message", insertWhiteboardRef);
    }
    const root = rootRef.current;
    if (!boardHost || !isTopWindow() || root === null) return;
    return registerBoardComposer({ root, threadKey, main: !inSubThreadView, insert });
  }, [
    applyPromptReplacement,
    boardHost,
    editorRef,
    inSubThreadView,
    promptRef,
    rootRef,
    threadKey,
  ]);
}

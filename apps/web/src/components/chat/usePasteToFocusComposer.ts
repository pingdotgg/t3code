import { pasteTextToFocusComposer, shouldRedirectInputToComposer } from "./composerFocusRedirect";
import { readPastedComposerContext } from "../composerInlineTokenPaste";
import { isPasteAsTextShortcut } from "@t3tools/client-runtime/text-paste";
import { useEffect, useRef } from "react";
import { isMacPlatform } from "../../lib/utils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { chatViewOf } from "./composerEventScope";
import type { ThreadId } from "@t3tools/contracts";
import type { ComposerHandleRef } from "../../composerHandleContext";
/**
 * Paste-to-focus: the resting composer blurs on a click into the timeline, so a paste that
 * follows has no editable target and would be dropped. This sends it to the composer instead.
 */
export function usePasteToFocusComposer(input: {
  readonly activeThreadId: ThreadId | null;
  readonly composerRef: ComposerHandleRef;
  /** A side chat inside its parent's panel; the parent routes pastes for both. */
  readonly embedded: boolean;
  /** The side chat that has this thread's composer, and its composer handle. */
  readonly focusedSideChatId: string | null;
  readonly sideComposerRef: ComposerHandleRef;
}) {
  const { activeThreadId, composerRef, embedded, focusedSideChatId, sideComposerRef } = input;
  const pasteAsTextShortcutUntilRef = useRef(0);
  useEffect(() => {
    if (embedded) return;
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      // A paste inside a side chat goes to its composer only while it has the
      // thread's composer; otherwise it isn't this thread's to take.
      const targetChat = chatViewOf(event.target);
      if (targetChat !== null && targetChat !== focusedSideChatId) return;
      if (getTerminalFocusOwner() !== null) return;
      const pasteComposer =
        focusedSideChatId !== null ? sideComposerRef.current : composerRef.current;
      if (pasteComposer?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          pasteComposer?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        pasteComposer?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("paste", handler, true);
    return () => {
      window.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("paste", handler, true);
    };
  }, [activeThreadId, composerRef, embedded, focusedSideChatId, sideComposerRef]);
}

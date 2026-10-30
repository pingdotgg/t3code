import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import type { ChatShortcutCommands } from "./useChatShortcuts";

const openControl =
  (composerRef: ComposerHandleRef, control: Parameters<ChatComposerHandle["openControl"]>[0]) =>
  ({ event }: { readonly event: KeyboardEvent }) => {
    if (!event.repeat) composerRef.current?.openControl(control);
  };

/** Chords that open or step the composer's controls and its branch toolbar. Held keys do not repeat them. */
export function composerShortcutCommands(
  composerRef: ComposerHandleRef,
  branchToolbarRef: { readonly current: BranchToolbarHandle | null },
): ChatShortcutCommands {
  return {
    "modelPicker.toggle": ({ event }) => {
      if (!event.repeat) composerRef.current?.toggleModelPicker();
    },
    "composer.toggleRichText": ({ event }) => {
      // The flip remounts the editor, which would drop an unsaved citation comment.
      if (event.target instanceof Element && event.target.closest("[data-citation-comment-editor]"))
        return false;
      if (!event.repeat) composerRef.current?.toggleRichText();
    },
    "composer.increaseEffort": ({ event }) => {
      if (!event.repeat) composerRef.current?.stepReasoningEffort(1);
    },
    "composer.decreaseEffort": ({ event }) => {
      if (!event.repeat) composerRef.current?.stepReasoningEffort(-1);
    },
    "composer.host": openControl(composerRef, "composer.host"),
    "composer.effort": openControl(composerRef, "composer.effort"),
    "composer.mode": openControl(composerRef, "composer.mode"),
    "composer.workspace": openControl(composerRef, "composer.workspace"),
    "composer.branch": ({ event }) => {
      if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
    },
    "composer.previousWorktree": ({ event }) => {
      if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
    },
  } satisfies ChatShortcutCommands;
}

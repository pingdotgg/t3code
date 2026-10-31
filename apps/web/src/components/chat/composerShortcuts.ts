import type { ComposerHandleRef } from "../../composerHandleContext";
import type { BranchToolbarHandle } from "../BranchToolbar";
import type { ChatComposerHandle } from "./ChatComposer";
import type { ChatShortcutCommands } from "./useChatShortcuts";
import { COMPOSER_EFFORT_KEYBINDING_COMMANDS } from "@t3tools/contracts";

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
    ...Object.fromEntries(
      COMPOSER_EFFORT_KEYBINDING_COMMANDS.map((command) => [
        command,
        ({ event }: { readonly event: KeyboardEvent }) => {
          if (!event.repeat)
            composerRef.current?.selectModelOption(command.slice("composer.setEffort.".length));
        },
      ]),
    ),
    "composer.toggleSpeed": ({ event }) => {
      if (!event.repeat) composerRef.current?.selectModelOption();
    },
    "modelPicker.toggle": ({ event }) => {
      if (!event.repeat) composerRef.current?.toggleModelPicker();
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

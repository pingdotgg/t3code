import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { THREAD_ALREADY_IN_NO_PROJECT, slashMenuRowText } from "./composerSend.logic";

type SlashCommandItem = Extract<ComposerCommandItem, { type: "slash-command" }>;

/**
 * The `/cd` and `/no` rows of the slash menu. A blocked row says why in its description, and
 * keeps the full sentence for the toast that choosing the row shows.
 */
export function folderMoveSlashCommandItems(input: {
  readonly available: boolean;
  readonly disabledReason: string | null;
  readonly inNoProject: boolean;
}): ReadonlyArray<SlashCommandItem> {
  if (!input.available) return [];
  return (["cd", "no"] as const).map((command) => {
    // `/no` has nowhere to go from No project, so the row says so before it runs.
    const blockReason =
      input.disabledReason ??
      (command === "no" && input.inNoProject ? THREAD_ALREADY_IN_NO_PROJECT : null);
    return {
      id: `slash:${command}`,
      type: "slash-command",
      command,
      label: `/${command}`,
      description:
        blockReason !== null
          ? slashMenuRowText(blockReason)
          : command === "cd"
            ? "Move this thread to another folder"
            : "Move to No project in a new scratch folder",
      ...(blockReason === null ? {} : { blockReason }),
    };
  });
}

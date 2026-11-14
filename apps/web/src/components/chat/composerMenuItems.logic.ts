import type { ComposerCommandItem } from "./ComposerCommandMenu";

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
    // `/no` has nowhere to go from No project. The server refuses it with the same sentence.
    const blockReason =
      input.disabledReason ??
      (command === "no" && input.inNoProject ? "This thread is already in No project." : null);
    return {
      id: `slash:${command}`,
      type: "slash-command",
      command,
      label: `/${command}`,
      // A slash menu row ends with no period, like the rows around it.
      description:
        blockReason !== null
          ? blockReason.replace(/\.$/u, "")
          : command === "cd"
            ? "Move this thread to another folder"
            : "Move to No project in a new scratch folder",
      ...(blockReason === null ? {} : { blockReason }),
    };
  });
}

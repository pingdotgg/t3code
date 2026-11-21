/**
 * Where the permissions chip shows, whether the mode block overflows, and which control answers
 * the composer.mode shortcut. The model picker's footer always holds Permissions, so the chip
 * only shows while the mode differs from the default. The rule: composer.mode has one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  /** The tool presets chip, which follows the mode block and so overflows first. */
  readonly toolsBlock?: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const accessDisplay = input.matchesDefault
    ? ("hidden" as const)
    : input.collapsed
      ? ("icon" as const)
      : ("label" as const);
  const showModeBlock = accessDisplay !== "hidden";
  const blockIds: ReadonlyArray<"mode" | "tools"> = [
    ...(showModeBlock ? (["mode"] as const) : []),
    ...(input.toolsBlock ? (["tools"] as const) : []),
  ];
  const hiddenBlockIds = blockIds.slice(
    Math.max(0, blockIds.length - input.measuredHiddenBlockCount),
  );
  const modeHidden = hiddenBlockIds.includes("mode");
  const overflowShowsPermissions = modeHidden;
  return {
    accessDisplay,
    showModeBlock,
    blockIds,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    modeHidden,
    toolsHidden: hiddenBlockIds.includes("tools"),
    overflowShowsPermissions,
    /** Without a visible chip or an overflow menu holding it, the model picker answers composer.mode. */
    pickerOwnsModeShortcut: !overflowShowsPermissions && (accessDisplay === "hidden" || modeHidden),
  };
}

/**
 * Where the permissions control lives, which blocks overflow, and which menu answers the
 * composer.mode shortcut. Blocks are ordered [traits, mode]; the last block overflows first.
 * The rule: Permissions have exactly one visible home and composer.mode exactly one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  /** The model has an effort (traits) menu, which then always holds Permissions. */
  readonly hasTraits: boolean;
  readonly planModeUiEnabled: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const accessDisplay = !input.matchesDefault
    ? input.collapsed
      ? ("icon" as const)
      : ("label" as const)
    : // Without traits there is no effort menu to hold Permissions, so keep an icon.
      input.hasTraits
      ? ("hidden" as const)
      : ("icon" as const);
  const showModeBlock = !(accessDisplay === "hidden" && !input.planModeUiEnabled);
  const blockIds = [
    ...(input.hasTraits ? ["traits" as const] : []),
    ...(showModeBlock ? ["mode" as const] : []),
  ];
  const hiddenFor = (count: number) => blockIds.slice(blockIds.length - count);
  const overflowShowsPermissionsFor = (hidden: ReadonlyArray<string>) =>
    hidden.includes(input.hasTraits ? "traits" : "mode");
  const overflowHasContent = (hidden: ReadonlyArray<string>) =>
    hidden.includes("traits") ||
    (input.planModeUiEnabled && hidden.includes("mode")) ||
    overflowShowsPermissionsFor(hidden);

  let hiddenBlockCount = Math.min(input.measuredHiddenBlockCount, blockIds.length);
  // An overflow menu with nothing in it must not exist: overflow one more block instead.
  while (
    hiddenBlockCount > 0 &&
    hiddenBlockCount < blockIds.length &&
    !overflowHasContent(hiddenFor(hiddenBlockCount))
  ) {
    hiddenBlockCount += 1;
  }
  const hiddenBlockIds = hiddenFor(hiddenBlockCount);
  const modeHidden = hiddenBlockIds.includes("mode");
  const traitsHidden = hiddenBlockIds.includes("traits");
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount,
    hiddenBlockIds,
    traitsHidden,
    modeHidden,
    /**
     * The effort chip answers composer.mode while the chip is hidden or overflowed, until the
     * effort chip overflows too; then the overflow menu (which holds Permissions) answers it.
     */
    effortOwnsModeShortcut: (input.matchesDefault || modeHidden) && !traitsHidden,
    overflowShowsPermissions: overflowShowsPermissionsFor(hiddenBlockIds),
  };
}

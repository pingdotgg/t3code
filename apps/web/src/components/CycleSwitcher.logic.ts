import type { KeybindingCommand } from "@t3tools/contracts";

export type CycleSwitcherDirection = 1 | -1;
export const CYCLE_SWITCHER_MODE = {
  project: "project",
  thread: "thread",
} as const;
export type CycleSwitcherMode = (typeof CYCLE_SWITCHER_MODE)[keyof typeof CYCLE_SWITCHER_MODE];
export type CycleSwitcherModifierKey = "metaKey" | "ctrlKey" | "altKey" | "shiftKey";

export interface CycleSwitcherCommandInfo {
  readonly mode: CycleSwitcherMode;
  readonly direction: CycleSwitcherDirection;
}

export interface CycleSwitcherModifierStateLike {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

// Shift only selects direction, so it is never a commit modifier. Meta/Ctrl/Alt
// are the "hold to keep the switcher open" modifiers; the first one released
// commits, matching the OS window switcher. A chord with none of them is
// rejected by the caller, since there would be nothing to hold and release.
const PRIMARY_COMMIT_MODIFIERS = ["metaKey", "ctrlKey", "altKey"] as const;

export function cycleSwitcherCommandInfo(
  command: KeybindingCommand | null,
): CycleSwitcherCommandInfo | null {
  switch (command) {
    case "project.switcher":
      return { mode: CYCLE_SWITCHER_MODE.project, direction: 1 };
    case "project.switcherPrevious":
      return { mode: CYCLE_SWITCHER_MODE.project, direction: -1 };
    case "thread.switcher":
      return { mode: CYCLE_SWITCHER_MODE.thread, direction: 1 };
    case "thread.switcherPrevious":
      return { mode: CYCLE_SWITCHER_MODE.thread, direction: -1 };
    default:
      return null;
  }
}

/** Maps a signed step offset onto a wrapping list index. */
export function resolveCycleSwitcherIndex(input: {
  readonly stepOffset: number;
  readonly length: number;
  readonly currentIndex: number;
  readonly initialDirection: CycleSwitcherDirection;
}): number {
  const { stepOffset, length, currentIndex, initialDirection } = input;
  if (length <= 0) return 0;

  // With no current entry, start just before the first item when cycling
  // forward and just after it when cycling backward. The first press then
  // selects the first or last item instead of skipping one.
  const startIndex = currentIndex >= 0 ? currentIndex : initialDirection === 1 ? -1 : 0;
  return (((startIndex + stepOffset) % length) + length) % length;
}

export function commitModifiersForShortcutEvent(
  event: CycleSwitcherModifierStateLike,
): ReadonlyArray<CycleSwitcherModifierKey> {
  return PRIMARY_COMMIT_MODIFIERS.filter((modifier) => event[modifier]);
}

export function cycleSwitcherCommitModifiersReleased(
  state: CycleSwitcherModifierStateLike,
  commitModifiers: ReadonlyArray<CycleSwitcherModifierKey>,
): boolean {
  if (commitModifiers.length === 0) return false;
  return !commitModifiers.some((modifier) => state[modifier]);
}

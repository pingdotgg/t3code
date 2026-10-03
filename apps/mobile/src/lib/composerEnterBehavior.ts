/**
 * What the Return key does in the composer on a hardware keyboard. `send`
 * submits the draft and Shift-Return inserts a newline; `newline` inserts a
 * newline and Command-Return (Ctrl-Return on Android) submits.
 */
export type ComposerEnterBehavior = "send" | "newline";

export const DEFAULT_COMPOSER_ENTER_BEHAVIOR: ComposerEnterBehavior = "send";

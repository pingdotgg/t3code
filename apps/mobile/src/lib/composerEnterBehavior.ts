/**
 * What the Return key does in the composer on a hardware keyboard. `send`
 * submits the draft and Shift-Return inserts a newline; `newline` inserts a
 * newline and Command-Return submits. Applies on iOS only — Android's composer
 * has no hardware Return handling.
 */
export type ComposerEnterBehavior = "send" | "newline";

export const DEFAULT_COMPOSER_ENTER_BEHAVIOR: ComposerEnterBehavior = "send";

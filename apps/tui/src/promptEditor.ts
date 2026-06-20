// Pure helpers for the "edit the prompt in $EDITOR" flow (^G). The side-effecting
// suspend/spawn/restore lives in ChatView; this is the testable part.

export interface EditorCommand {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Resolve the user's editor from $VISUAL / $EDITOR (falling back to vi), split
 * into a command + args so "code --wait" or "vim -u NONE" work. The temp file
 * path is appended by the caller.
 */
export function resolveEditorCommand(env: {
  readonly VISUAL?: string | undefined;
  readonly EDITOR?: string | undefined;
}): EditorCommand {
  const raw = (env.VISUAL || env.EDITOR || "vi").trim();
  const parts = raw.split(/\s+/u).filter((part) => part.length > 0);
  const [cmd, ...args] = parts.length > 0 ? parts : ["vi"];
  return { cmd: cmd ?? "vi", args };
}

/** Normalise editor output: CRLF→LF and drop the trailing newline editors append. */
export function normalizeEditedPrompt(text: string): string {
  return text.replace(/\r\n/gu, "\n").replace(/\n+$/u, "");
}

import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

export type PendingModifier = "ctrl" | "meta";
export type HostPlatform = "mac" | "linux" | "windows" | "unknown";

/** Upper bound of `TerminalWriteInput.data`; longer writes are rejected by the server. */
export const TERMINAL_WRITE_MAX_LENGTH = 65_536;

export type ModifiedTerminalInput =
  | { readonly kind: "write"; readonly data: string }
  | { readonly kind: "paste" };

// C0 controls other than tab, LF, and CR, plus DEL.
// eslint-disable-next-line no-control-regex -- Pasted text must not carry raw terminal controls.
const UNSAFE_PASTE_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Encodes a key pressed while the toolbar's one-shot ctrl modifier is armed
 * into the control byte a terminal expects.
 */
export function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
}

/**
 * Resolves what a keypress means once a toolbar modifier is armed. The host's
 * paste chord (cmd+v on a macOS host, ctrl+v elsewhere) pastes the device
 * clipboard instead of reaching the remote shell as a raw control byte, which
 * matches what the web terminal does with the same chord. Forwarding the byte
 * is never what a phone user means: PowerShell binds ctrl+v to paste from the
 * host machine's clipboard, so the shell inserts whatever the desktop last
 * copied rather than the text on the phone.
 */
export function resolveModifiedTerminalInput(input: {
  readonly data: string;
  readonly modifier: PendingModifier;
  readonly hostPlatform: HostPlatform;
}): ModifiedTerminalInput {
  const pasteModifier: PendingModifier = input.hostPlatform === "mac" ? "meta" : "ctrl";
  if (input.modifier === pasteModifier && input.data.toLowerCase() === "v") {
    return { kind: "paste" };
  }

  return {
    kind: "write",
    data: input.modifier === "ctrl" ? applyCtrlModifier(input.data) : `\u001b${input.data}`,
  };
}

/**
 * Encodes clipboard text for the remote pty the way the web terminal does when
 * bracketed paste is off: unsafe control bytes become spaces (which also
 * defuses an embedded bracketed-paste end marker, since its ESC goes too) and
 * line breaks become carriage returns, since a bare LF is Ctrl+J to a raw-mode
 * TUI. The native mobile surface does not expose DECSET 2004, so mobile never
 * wraps a paste in bracketed-paste markers.
 */
export function encodeTerminalPaste(text: string): string {
  return text.replace(UNSAFE_PASTE_BYTES, " ").replace(/\r\n|\n/g, "\r");
}

/**
 * Splits terminal input into writes the wire contract accepts, never cutting
 * through a surrogate pair so every chunk stays valid UTF-16.
 */
export function chunkTerminalWrite(data: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + TERMINAL_WRITE_MAX_LENGTH, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Maps the OS reported by the environment descriptor onto the toolbar's host
 * layout. Returns null for "unknown" so callers can fall back to a weaker signal.
 */
export function hostPlatformFromOs(os: ExecutionEnvironmentPlatformOs | null): HostPlatform | null {
  if (os === "darwin") return "mac";
  if (os === "linux") return "linux";
  if (os === "windows") return "windows";
  return null;
}

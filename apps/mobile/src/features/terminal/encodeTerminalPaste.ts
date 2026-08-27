/**
 * Encode clipboard text for PTY write, matching web Ghostty `encodePaste`
 * semantics as closely as we can without a native mode query.
 *
 * Web reads DECSET 2004 (bracketed paste) from libghostty and only wraps when
 * active. Mobile's native surface does not expose that mode yet, so callers
 * default to `bracketed: false` — never emit literal ESC[200~/ESC[201~ into
 * shells that have not enabled the mode.
 *
 * Always strips ESC[201~ from the payload to block paste-end injection.
 */

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function encodeTerminalPaste(
  text: string,
  options: { readonly bracketed?: boolean } = {},
): string {
  // Split/join so every occurrence is removed, including adjacent repeats.
  const sanitized = text.split(BRACKETED_PASTE_END).join("");
  if (sanitized.length === 0) {
    return "";
  }

  if (options.bracketed === true) {
    return `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`;
  }

  // Ghostty replaces newlines with CR when bracketed paste is off so each
  // line is a carriage return rather than a bare LF (Ctrl+J in raw mode).
  return sanitized.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

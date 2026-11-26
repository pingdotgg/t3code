// Claude Code sends a truncated request body when a prompt pairs a raw DEL with an escaped
// control character (anthropics/claude-code#94055), so text shown to agents keeps only \t and \n.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** `text` without C0 control characters other than tab and newline, and without DEL. */
export const withoutControlCharacters = (text: string): string =>
  text.replace(CONTROL_CHARACTERS, "");

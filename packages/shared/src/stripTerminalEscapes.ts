// Some CLIs (e.g. opencode <= 1.18) emit terminal escape sequences on stdout
// even when stdout is a pipe — most notably OSC title sets like
// `ESC ]0;<cwd>: ready BEL`. Anything that parses such output must strip them
// first, or the escapes leak into stored identifiers and slugs.

// OSC: `ESC ]` payload terminated by BEL or by ST (`ESC \`).
// eslint-disable-next-line no-control-regex -- matching control bytes is the point of this helper
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// CSI: `ESC [` parameter bytes (including the ITU T.416 colon subparameter
// separator) and optional intermediate bytes, followed by a final byte in
// @-~ — ANSI colors, cursor movement, mode set/reset, ...
// eslint-disable-next-line no-control-regex -- matching control bytes is the point of this helper
const CSI_SEQUENCE = /\u001b\[[0-9:;?<=>]*[ -/]*[@-~]/g;

/** Removes OSC and CSI escape sequences from terminal output. */
export function stripTerminalEscapes(text: string): string {
  return text.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "");
}

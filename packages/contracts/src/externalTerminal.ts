import * as Schema from "effect/Schema";

export const ExternalTerminalId = Schema.Literals([
  "system",
  "terminal",
  "iterm2",
  "ghostty",
  "windows-terminal",
  "gnome-terminal",
  "konsole",
  "xterm",
]);
export type ExternalTerminalId = typeof ExternalTerminalId.Type;

export const EXTERNAL_TERMINALS = [
  { id: "system", label: "Default", platforms: ["darwin", "win32", "linux"] },
  { id: "terminal", label: "Terminal", platforms: ["darwin"] },
  { id: "iterm2", label: "iTerm2", platforms: ["darwin"] },
  { id: "ghostty", label: "Ghostty", platforms: ["darwin", "linux"] },
  { id: "windows-terminal", label: "Windows Terminal", platforms: ["win32"] },
  { id: "gnome-terminal", label: "GNOME Terminal", platforms: ["linux"] },
  { id: "konsole", label: "Konsole", platforms: ["linux"] },
  { id: "xterm", label: "XTerm", platforms: ["linux"] },
] satisfies ReadonlyArray<{ id: ExternalTerminalId; label: string; platforms: string[] }>;

export const OpenExternalTerminalInput = Schema.Struct({
  terminal: ExternalTerminalId,
  cwd: Schema.NonEmptyString,
  sshHost: Schema.optionalKey(Schema.NonEmptyString),
  wslDistro: Schema.optionalKey(Schema.NonEmptyString),
});
export type OpenExternalTerminalInput = typeof OpenExternalTerminalInput.Type;

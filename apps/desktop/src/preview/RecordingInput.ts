export interface RecordingInputOptions {
  readonly showKeyPresses: boolean;
  readonly showMousePresses: boolean;
}

export const DEFAULT_RECORDING_INPUT_OPTIONS: RecordingInputOptions = {
  showKeyPresses: false,
  showMousePresses: false,
};

export interface RecordingKeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Formats a single chord without duplicating a modifier pressed on its own. */
export function recordingKeyLabel(input: RecordingKeyPress, isMac: boolean): string | null {
  if (["Dead", "Process", "Unidentified", ""].includes(input.key)) return null;
  const modifiers = [
    input.ctrlKey || input.key === "Control" ? (isMac ? "⌃" : "Ctrl") : null,
    input.altKey || input.key === "Alt" ? (isMac ? "⌥" : "Alt") : null,
    input.shiftKey || input.key === "Shift" ? (isMac ? "⇧" : "Shift") : null,
    input.metaKey || input.key === "Meta" ? (isMac ? "⌘" : "Win") : null,
  ].filter((value) => value !== null);
  const labels: Record<string, string> = {
    Enter: "↵",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Space: "Space",
  };
  if (!["Control", "Alt", "Shift", "Meta"].includes(input.key)) {
    modifiers.push(
      labels[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key),
    );
  }
  return modifiers.join(isMac ? "" : " + ");
}

/** Unknown iframe or closed-shadow focus is excluded because its field type cannot be checked. */
export function recordingKeysAreSensitive(document: Document): boolean {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return (
    element?.tagName === "IFRAME" ||
    element?.tagName.includes("-") === true ||
    element?.getAttribute("type")?.toLowerCase() === "password"
  );
}

import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";

/** Application output cannot use the focus-stealing, user-gesture copy fallback. */
export const writeTerminalClipboard = createTerminalClipboardWriter((text) =>
  navigator.clipboard?.writeText(text),
);

/** A click can authorize copying on HTTP pages, including clearing with empty text. */
export function copyTerminalClipboardFromGesture(text: string): boolean {
  let copied = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopPropagation();
    copied = true;
  };
  document.addEventListener("copy", onCopy, { capture: true });
  try {
    document.execCommand("copy");
    return copied;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, { capture: true });
  }
}

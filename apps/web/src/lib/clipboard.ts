export function canWriteClipboardText(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!canWriteClipboardText()) {
    throw new Error("Clipboard API unavailable.");
  }

  await navigator.clipboard.writeText(text);
}

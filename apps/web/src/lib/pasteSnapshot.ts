/**
 * Chromium reads a paste's clipboard again on every `getData()` and returns "" once the
 * clipboard has changed. A dictation tool that queues its next item (an image) after the first
 * read would empty every later read, so the first listener reads the strings once for all.
 */
export function installPasteSnapshot(target: Window): () => void {
  const snapshot = (event: ClipboardEvent) => {
    const live = event.clipboardData;
    if (!event.isTrusted || !live) return;
    // Native fields insert from the clipboard after dispatch; an early read would let the tool
    // replace it first.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const readLive = live.getData.bind(live);
    const strings = new Map<string, string>();
    // Plain text first: a tool that waits for the read offers only text, then replaces it.
    const types = [...live.types].toSorted((a, b) =>
      a === "text/plain" ? -1 : b === "text/plain" ? 1 : 0,
    );
    for (const type of types) {
      if (type !== "Files") strings.set(type, readLive(type));
    }
    // Files and items stay native: folder detection needs their file system entries.
    Object.defineProperty(live, "getData", {
      value: (format: string) => {
        const type = format.toLowerCase() === "text" ? "text/plain" : format.toLowerCase();
        return strings.get(type) ?? readLive(format);
      },
    });
  };
  target.addEventListener("paste", snapshot, true);
  return () => target.removeEventListener("paste", snapshot, true);
}

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
    // Files go before any text read: `getAsFile()` returns null once the clipboard has changed.
    if (live.types.includes("Files")) {
      const items = Array.from(live.items, (item): DataTransferItem => {
        if (item.kind !== "file") return item;
        const file = item.getAsFile();
        // Folder detection needs the entry, which is also gone once the clipboard changes.
        const entry = item.webkitGetAsEntry();
        return {
          kind: item.kind,
          type: item.type,
          getAsFile: () => file,
          getAsString: (callback) => item.getAsString(callback),
          webkitGetAsEntry: () => entry,
        };
      });
      const files = items.flatMap((item) => {
        const file = item.kind === "file" ? item.getAsFile() : null;
        return file ? [file] : [];
      });
      Object.defineProperty(live, "items", { value: items });
      Object.defineProperty(live, "files", { value: files });
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

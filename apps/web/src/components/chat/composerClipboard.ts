export function getClipboardFiles(clipboardData: DataTransfer): File[] {
  const files = Array.from(clipboardData.files);
  if (files.length > 0) return files;

  return Array.from(clipboardData.items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

interface ComposerPasteEvent {
  defaultPrevented: boolean;
  clipboardData: DataTransfer;
  preventDefault: () => void;
}

export function handleComposerPaste(
  event: ComposerPasteEvent,
  {
    editingQueuedTurn,
    addImages,
  }: {
    editingQueuedTurn: boolean;
    addImages: (files: File[]) => void;
  },
): void {
  if (event.defaultPrevented) return;
  const files = getClipboardFiles(event.clipboardData);
  if (files.length === 0) return;

  // Queued edits keep normal text paste, but cannot import files into the separate draft.
  if (editingQueuedTurn) {
    event.preventDefault();
    return;
  }

  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  if (imageFiles.length === 0) return;
  event.preventDefault();
  addImages(imageFiles);
}

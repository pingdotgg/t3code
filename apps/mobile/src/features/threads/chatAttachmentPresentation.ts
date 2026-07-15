const BYTES_PER_KILOBYTE = 1024;

export function formatChatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < BYTES_PER_KILOBYTE) {
    return `${sizeBytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = sizeBytes;
  let unitIndex = -1;
  while (value >= BYTES_PER_KILOBYTE && unitIndex < units.length - 1) {
    value /= BYTES_PER_KILOBYTE;
    unitIndex += 1;
  }

  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

export function chatAttachmentAccessibilityLabel(name: string, sizeBytes: number): string {
  return `${name}, ${formatChatAttachmentSize(sizeBytes)} image. Opens a full-screen preview.`;
}

const SIZE_LABEL_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatAttachmentSizeLabel(sizeBytes: number): string {
  let value = Math.max(0, sizeBytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_LABEL_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${SIZE_LABEL_UNITS[unitIndex]}`;
}

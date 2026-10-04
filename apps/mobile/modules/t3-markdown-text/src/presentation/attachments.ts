export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

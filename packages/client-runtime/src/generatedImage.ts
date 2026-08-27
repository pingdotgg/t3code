export interface GeneratedImageRef {
  readonly imageId: string;
  readonly filename: string;
  readonly mimeType?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asGeneratedImage(value: unknown): GeneratedImageRef | undefined {
  const record = asRecord(value);
  if (typeof record?.imageId !== "string" || record.imageId.trim().length === 0) {
    return undefined;
  }
  const filename =
    typeof record.filename === "string" && record.filename.trim().length > 0
      ? record.filename
      : record.imageId;
  return {
    imageId: record.imageId,
    filename,
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
  };
}

export function extractGeneratedImage(value: unknown): GeneratedImageRef | undefined {
  const direct = asGeneratedImage(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return undefined;
  return (
    asGeneratedImage(record.generatedImage) ??
    asGeneratedImage(record.image) ??
    extractGeneratedImage(record.item) ??
    extractGeneratedImage(record.result) ??
    extractGeneratedImage(record.structuredContent)
  );
}

function readMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  // upstream errors often nest the useful part, e.g. {"type":"error","status":400,"error":{"message":...}}
  return readMessage(record.error);
}

/**
 * Providers sometimes surface the raw upstream error body as the error
 * message string (e.g. `{"type":"error","status":400,"error":{"type":
 * "invalid_request_error","message":"..."}}`). Pull out the human readable
 * message when that happens; otherwise return the input unchanged.
 */
export function extractProviderErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return message;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return message;
  }
  const extracted = readMessage(parsed);
  if (extracted === undefined || extracted === trimmed) {
    return message;
  }
  // handles double-encoded payloads; the inequality check above guarantees progress
  return extractProviderErrorMessage(extracted);
}

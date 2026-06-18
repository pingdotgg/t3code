export function findErrorTraceId(error: unknown): string | null {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as {
      readonly cause?: unknown;
      readonly traceId?: unknown;
    };
    if (typeof record.traceId === "string" && record.traceId.trim().length > 0) {
      return record.traceId;
    }
    current = record.cause;
  }

  return null;
}

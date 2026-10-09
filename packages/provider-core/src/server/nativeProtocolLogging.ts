import { errorTag } from "@t3tools/shared/observability";

export function structuralProtocolMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

/**
 * Retain only bounded structural metadata for native protocol diagnostics.
 * Provider payload values may contain prompts, credentials, or arbitrarily
 * large tool output and must never be copied into the observability stream.
 */
export function summarizeNativeProtocolPayload(
  payload: unknown,
): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (typeof payload === "string") {
    return { valueType: "string", byteLength: new TextEncoder().encode(payload).byteLength };
  }
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (Array.isArray(payload)) {
    return { valueType: "array", itemCount: payload.length };
  }
  if (typeof payload !== "object") {
    return { valueType: typeof payload };
  }

  try {
    const record = payload as Record<string, unknown>;
    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      ...(typeof record._tag === "string" ? { messageTag: errorTag(record) } : {}),
      ...(typeof record.tag === "string" ? { method: structuralProtocolMethod(record.tag) } : {}),
    };
  } catch {
    return { valueType: "object" };
  }
}

import { copyJson, type Json } from "@t3tools/extension-sdk/contracts";

/** The envelope is host protocol overhead; each public payload retains its own SDK bound. */
export function copyEnvelope(value: unknown, maxBytes = 256 * 1024): Record<string, Json> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 12
  )
    throw new Error("Invalid worker envelope");
  const result: Record<string, Json> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key.length > 32) throw new Error("Invalid worker field");
    result[key] = copyJson(field as Json, maxBytes);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new Error("Worker envelope exceeds limit");
  return result;
}

import { Buffer } from "node:buffer";

export const ACTIVITY_PAYLOAD_BLOB_THRESHOLD_BYTES = 16 * 1024;

export interface CompactActivityPayloadResult {
  readonly payload: unknown;
  readonly dataJson: string | null;
  readonly sizeBytes: number;
}

export function compactActivityPayload(
  kind: string,
  payload: unknown,
): CompactActivityPayloadResult {
  if (
    !kind.startsWith("tool.") ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, "data")
  ) {
    return { payload, dataJson: null, sizeBytes: 0 };
  }

  const { data, ...compact } = payload as Record<string, unknown>;
  const dataJson = JSON.stringify(data);
  if (dataJson === undefined) {
    return { payload, dataJson: null, sizeBytes: 0 };
  }
  const sizeBytes = Buffer.byteLength(dataJson);
  return sizeBytes >= ACTIVITY_PAYLOAD_BLOB_THRESHOLD_BYTES
    ? { payload: compact, dataJson, sizeBytes }
    : { payload, dataJson: null, sizeBytes };
}

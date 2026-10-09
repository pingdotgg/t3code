import type * as firestore from "@distilled.cloud/gcp/firestore_v1";

/**
 * Codec between plain JavaScript values and Firestore REST `Value`s.
 * NOT exported from `index.ts`.
 *
 * Encoding: `null`/`undefined` → `nullValue`, booleans → `booleanValue`,
 * integral numbers and bigints → `integerValue`, other numbers →
 * `doubleValue`, strings → `stringValue`, `Date` → `timestampValue`,
 * `Uint8Array` → `bytesValue`, arrays → `arrayValue`, plain objects →
 * `mapValue`. Decoding reverses this; `integerValue`s outside the safe
 * integer range decode to `bigint`, `geoPointValue` to
 * `{ latitude, longitude }`, and `referenceValue` to its resource name.
 */

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const encodeValue = (value: unknown): firestore.Value => {
  if (value === null || value === undefined) return { nullValue: "NULL_VALUE" };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "bigint") return { integerValue: value.toString() };
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value instanceof Uint8Array) return { bytesValue: toBase64(value) };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value as object) } };
  }
  return { stringValue: String(value) };
};

/** Encode a plain object's own enumerable keys; `undefined` keys are dropped. */
export const encodeFields = (fields: object): firestore.ValueMap => {
  const out: Record<string, firestore.Value> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = encodeValue(value);
  }
  return out;
};

const decodeDouble = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

export const decodeValue = (value: firestore.Value): unknown => {
  if (value.nullValue !== undefined) return null;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) {
    const big = BigInt(value.integerValue);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) &&
      big <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(big)
      : big;
  }
  if (value.doubleValue !== undefined) return decodeDouble(value.doubleValue);
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.timestampValue !== undefined) return new Date(value.timestampValue);
  if (value.bytesValue !== undefined) return fromBase64(value.bytesValue);
  if (value.referenceValue !== undefined) return value.referenceValue;
  if (value.geoPointValue !== undefined) {
    return {
      latitude: value.geoPointValue.latitude ?? 0,
      longitude: value.geoPointValue.longitude ?? 0,
    };
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map(decodeValue);
  }
  if (value.mapValue !== undefined) {
    return decodeFields(value.mapValue.fields);
  }
  return null;
};

export const decodeFields = (
  fields: firestore.ValueMap | undefined,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) out[key] = decodeValue(value);
  }
  return out;
};

/** Quote a field name for an update mask when it is not a simple identifier. */
export const fieldPath = (key: string): string =>
  /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(key)
    ? key
    : `\`${key.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

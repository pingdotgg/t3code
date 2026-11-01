// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
type ViewConstructor = new (buffer: ArrayBufferLike) => ArrayBufferView;

function buildCompactView(view: ArrayBufferView): ArrayBufferView {
  const tightBuffer = view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  return new (view.constructor as ViewConstructor)(tightBuffer);
}

/**
 * Returns a copy of `value` that is safe to persist via Durable Object storage
 * without dragging unrelated bytes along with typed-array views.
 *
 * Background: workerd's `v8::ValueSerializer` writes the entire backing
 * `ArrayBuffer` for typed-array views, not just `byteLength` bytes. A view
 * sliced from a much larger buffer (`crypto.getRandomValues`, `arr.slice(...)`,
 * fetch-stream copies) blows up the wire size by a factor of
 * (backing-size / view-size) and can hit `SQLITE_TOOBIG` at view sizes well
 * below the documented 1MiB output limit (see issue #14101). Copying the
 * view's bytes into a tight backing buffer before persistence brings local
 * `wrangler dev` behaviour in line with production.
 *
 * The walk is recursive (cycle-safe via a `WeakMap`) so views nested inside
 * objects, arrays, Maps, and Sets are also compacted. View types are preserved
 * (`Uint8Array` stays `Uint8Array`, `Int16Array` stays `Int16Array`, etc.) so
 * the persisted shape matches the live shape. Class instances and host objects
 * (`Date`, `RegExp`, raw `ArrayBuffer`, streams, `Blob`, …) are passed through
 * unchanged — recursing into them would either fail to reconstruct the
 * original type or trigger their own structured-clone path.
 *
 * @param value The value to normalize for storage.
 * @param seen Previously visited objects, used to preserve cycles.
 * @returns A storage-safe copy of the value.
 */
export function normalizeForStorage(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (ArrayBuffer.isView(value)) {
    return buildCompactView(value);
  }

  if (Array.isArray(value)) {
    const result: Array<unknown> = [];
    seen.set(value, result);
    for (const item of value) {
      result.push(normalizeForStorage(item, seen));
    }
    return result;
  }

  if (value instanceof Map) {
    const result = new Map<unknown, unknown>();
    seen.set(value, result);
    for (const [key, item] of value) {
      result.set(
        normalizeForStorage(key, seen),
        normalizeForStorage(item, seen),
      );
    }
    return result;
  }

  if (value instanceof Set) {
    const result = new Set<unknown>();
    seen.set(value, result);
    for (const item of value) {
      result.add(normalizeForStorage(item, seen));
    }
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const key of Object.keys(value)) {
      result[key] = normalizeForStorage(
        (value as Record<string, unknown>)[key],
        seen,
      );
    }
    return result;
  }

  return value;
}

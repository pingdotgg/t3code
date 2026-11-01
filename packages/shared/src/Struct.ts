import * as P from "effect/Predicate";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Drops `__proto__` own keys at every depth, preserving object identity when
 * there is nothing to strip. Assignment through such a key would invoke the
 * prototype setter instead of defining a property. Cyclic back-references
 * resolve to the sanitized clone under construction, never to the original.
 */
function stripProtoKeys(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    const next: Array<unknown> = [];
    seen.set(value, next);
    let changed = false;
    for (const item of value) {
      const cleaned = stripProtoKeys(item, seen);
      if (cleaned !== item) changed = true;
      next.push(cleaned);
    }
    if (!changed) {
      seen.set(value, value);
      return value;
    }
    return next;
  }
  if (!P.isObject(value)) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  const next: Record<string, unknown> = {};
  seen.set(value, next);
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") {
      changed = true;
      continue;
    }
    const cleaned = stripProtoKeys(child, seen);
    if (cleaned !== child) changed = true;
    next[key] = cleaned;
  }
  if (!changed) {
    seen.set(value, value);
    return value;
  }
  return next;
}

export function deepMerge<T extends Record<string, unknown>>(current: T, patch: DeepPartial<T>): T {
  if (!P.isObject(current) || !P.isObject(patch)) {
    return patch as T;
  }
  const cleanPatch = stripProtoKeys(patch) as DeepPartial<T>;

  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(cleanPatch)) {
    if (value === undefined || key === "__proto__") continue;

    const existing = next[key];
    next[key] = P.isObject(existing) && P.isObject(value) ? deepMerge(existing, value) : value;
  }

  return next as T;
}

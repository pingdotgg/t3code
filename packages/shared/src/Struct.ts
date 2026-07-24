import * as P from "effect/Predicate";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function deepMerge<T extends Record<string, unknown>>(current: T, patch: DeepPartial<T>): T {
  if (!P.isObject(current)) {
    return patch as T;
  }

  if (!P.isObject(patch)) {
    if (patch !== null) {
      throw new Error(`deepMerge: patch must be a plain object, received ${typeof patch}`);
    }
    return patch as T;
  }

  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = next[key];
    next[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return next as T;
}

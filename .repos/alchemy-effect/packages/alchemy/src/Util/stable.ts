import { isPlainObject } from "./data.ts";

export const normalizeNulls = <T>(value: T): T => {
  if (value === null) {
    return undefined as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeNulls(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, nested]) => [key, normalizeNulls(nested)])
        .filter(([, nested]) => nested !== undefined),
    ) as T;
  }
  return value;
};

export const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

export const stableStringify = (value: unknown) =>
  JSON.stringify(stableValue(normalizeNulls(value) ?? null));

import { isPlainObject } from "./data.ts";

export const camelCaseKey = (key: string) =>
  key
    .replace(/^_+/, "")
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const toCamelCase = <T>(value: unknown): T => {
  if (Array.isArray(value)) {
    return value.map((item) => toCamelCase(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        camelCaseKey(key),
        toCamelCase(nested),
      ]),
    ) as T;
  }
  return value as T;
};

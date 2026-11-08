import { parse, stringify } from "yaml";

import { markdownFrontmatterSource } from "./markdownFrontmatter.ts";

export interface MarkdownFrontmatterProperty {
  readonly key: string;
  readonly value: string;
  /** A list or map, written as inline YAML. */
  readonly structured: boolean;
}

/**
 * Reads leading YAML frontmatter as one row per top-level key. Returns null when
 * there is none, it is not valid YAML, or it is not a non-empty map.
 */
export function markdownFrontmatterProperties(
  markdown: string,
): ReadonlyArray<MarkdownFrontmatterProperty> | null {
  const source = markdownFrontmatterSource(markdown);
  if (source === null) return null;
  let data: unknown;
  try {
    data = parse(source, { logLevel: "error" });
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const properties = Object.entries(data).map(([key, value]): MarkdownFrontmatterProperty => {
    if (value !== null && typeof value === "object") {
      return {
        key,
        value: stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd(),
        structured: true,
      };
    }
    return { key, value: value == null ? "" : String(value).trimEnd(), structured: false };
  });
  return properties.length > 0 ? properties : null;
}

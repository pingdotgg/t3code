import { parse as parseYamlDocument } from "yaml";

export interface SkillGroup {
  readonly group?: string;
  readonly groupOrder?: number;
}

/** The Agent Skills spec types `metadata` values as strings, so `group-order` may arrive quoted. */
export function skillGroupFromFrontmatter(record: Record<string, unknown>): SkillGroup {
  const metadata = record.metadata;
  if (typeof metadata !== "object" || metadata === null) return {};
  const { group: rawGroup, "group-order": rawOrder } = metadata as Record<string, unknown>;
  const group = typeof rawGroup === "string" ? rawGroup.trim() : "";
  if (!group) return {};
  const groupOrder =
    typeof rawOrder === "number"
      ? rawOrder
      : typeof rawOrder === "string" && rawOrder.trim() !== ""
        ? Number(rawOrder)
        : Number.NaN;
  return Number.isFinite(groupOrder) ? { group, groupOrder } : { group };
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function skillGroupFromSkillFile(contents: string): SkillGroup {
  const frontmatter = FRONTMATTER_PATTERN.exec(contents)?.[1];
  if (frontmatter === undefined) return {};
  try {
    const parsed: unknown = parseYamlDocument(frontmatter);
    return typeof parsed === "object" && parsed !== null
      ? skillGroupFromFrontmatter(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

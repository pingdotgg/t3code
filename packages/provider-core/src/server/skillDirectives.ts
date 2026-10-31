import { hashTelemetryId } from "@t3tools/shared/telemetryId";

export interface SkillDirectiveEntry {
  readonly skillName: string;
  readonly mode: "variant" | "off";
  readonly variantPath: string | null;
}

export interface RenderSkillDirectivesOptions {
  readonly variantReference?: "path" | "claude-plugin";
}

export const CLAUDE_SKILL_VARIANT_PLUGIN_NAME = "t3-variants";
const CLAUDE_SKILL_VARIANT_SUFFIX = "-t3-variant";
const SKILL_NAME_MAX_LENGTH = 64;
const TRUNCATED_SKILL_HASH_LENGTH = 8;

/** Claude's `Skill(name)` deny also blocks `plugin:name`, so a variant needs its own name. */
export const claudeSkillVariantName = (skillName: string): string => {
  if (skillName.length + CLAUDE_SKILL_VARIANT_SUFFIX.length <= SKILL_NAME_MAX_LENGTH) {
    return `${skillName}${CLAUDE_SKILL_VARIANT_SUFFIX}`;
  }
  const hash = hashTelemetryId(skillName).slice(0, TRUNCATED_SKILL_HASH_LENGTH);
  const prefixLength =
    SKILL_NAME_MAX_LENGTH - CLAUDE_SKILL_VARIANT_SUFFIX.length - TRUNCATED_SKILL_HASH_LENGTH - 1;
  return `${skillName.slice(0, prefixLength)}-${hash}${CLAUDE_SKILL_VARIANT_SUFFIX}`;
};

export const claudeSkillVariantQualifiedName = (skillName: string): string =>
  `${CLAUDE_SKILL_VARIANT_PLUGIN_NAME}:${claudeSkillVariantName(skillName)}`;

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const renderSkillDirectives = (
  entries: readonly SkillDirectiveEntry[],
  options: RenderSkillDirectivesOptions = {},
): string => {
  const directives = entries
    .filter(
      (entry) => entry.mode === "off" || (entry.mode === "variant" && entry.variantPath !== null),
    )
    .toSorted((left, right) =>
      left.skillName < right.skillName ? -1 : left.skillName > right.skillName ? 1 : 0,
    )
    .map((entry) => {
      const skillName = escapeXmlAttribute(entry.skillName);
      if (entry.mode === "off") return `- Skill "${skillName}": do not use it for this model.`;
      if (options.variantReference === "claude-plugin") {
        const variantName = escapeXmlAttribute(claudeSkillVariantQualifiedName(entry.skillName));
        return `- Skill "${skillName}": use "${variantName}" for this model instead.`;
      }
      return `- Skill "${skillName}": use ${entry.variantPath} instead of its own SKILL.md.`;
    });

  if (directives.length === 0) return "";
  return [
    "<t3_skill_variants>",
    "T3 Code adjusts some skills for this model.",
    ...directives,
    "</t3_skill_variants>",
  ].join("\n");
};

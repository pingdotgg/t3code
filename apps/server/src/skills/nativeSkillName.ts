import {
  CLAUDE_SKILL_VARIANT_PLUGIN_NAME,
  claudeSkillVariantName,
} from "@t3tools/provider-core/server/skillDirectives";

const nativeSkillName = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const skill = (input as Record<string, unknown>)["skill"];
  return typeof skill === "string" ? skill.trim() : null;
};

export const matchesNativeSkillName = (input: unknown, skillName: string): boolean => {
  const qualified = nativeSkillName(input)?.toLowerCase();
  if (qualified === undefined || qualified === null || qualified.length === 0) return false;
  const parts = qualified.split(":");
  if (parts.length === 1) return parts[0] === skillName.toLowerCase();
  if (parts.length !== 2) return false;
  const [qualifier, logicalName] = parts;
  if (qualifier === CLAUDE_SKILL_VARIANT_PLUGIN_NAME) {
    return logicalName === claudeSkillVariantName(skillName).toLowerCase();
  }
  return qualifier === "plugin" && logicalName === skillName.toLowerCase();
};

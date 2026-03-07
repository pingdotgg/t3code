import { Schema } from "effect";

// ── Skill metadata returned by list ─────────────────────────────────

export const SkillMetadata = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  agents: Schema.Array(Schema.String),
});
export type SkillMetadata = typeof SkillMetadata.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillMetadata),
});
export type SkillsListResult = typeof SkillsListResult.Type;

// ── Toggle skill on/off ─────────────────────────────────────────────

export const SkillsToggleInput = Schema.Struct({
  skillName: Schema.String,
  enabled: Schema.Boolean,
});
export type SkillsToggleInput = typeof SkillsToggleInput.Type;

export const SkillsToggleResult = Schema.Struct({
  skillName: Schema.String,
  enabled: Schema.Boolean,
});
export type SkillsToggleResult = typeof SkillsToggleResult.Type;

// ── Search skills.sh registry (Phase 2) ─────────────────────────────

export const SkillsSearchInput = Schema.Struct({
  query: Schema.String,
});
export type SkillsSearchInput = typeof SkillsSearchInput.Type;

export const SkillSearchResultEntry = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  installs: Schema.String,
  url: Schema.String,
});
export type SkillSearchResultEntry = typeof SkillSearchResultEntry.Type;

export const SkillsSearchResult = Schema.Struct({
  skills: Schema.Array(SkillSearchResultEntry),
});
export type SkillsSearchResult = typeof SkillsSearchResult.Type;

// ── Install skill from skills.sh (Phase 2) ──────────────────────────

export const SkillsInstallInput = Schema.Struct({
  source: Schema.String,
  skillName: Schema.String,
});
export type SkillsInstallInput = typeof SkillsInstallInput.Type;

export const SkillsInstallResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
});
export type SkillsInstallResult = typeof SkillsInstallResult.Type;

// ── Uninstall skill ─────────────────────────────────────────────────

export const SkillsUninstallInput = Schema.Struct({
  skillName: Schema.String,
});
export type SkillsUninstallInput = typeof SkillsUninstallInput.Type;

export const SkillsUninstallResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.String,
});
export type SkillsUninstallResult = typeof SkillsUninstallResult.Type;

// ── Read skill content ──────────────────────────────────────────────

export const SkillsReadContentInput = Schema.Struct({
  skillName: Schema.String,
});
export type SkillsReadContentInput = typeof SkillsReadContentInput.Type;

export const SkillsReadContentResult = Schema.Struct({
  skillName: Schema.String,
  content: Schema.String,
});
export type SkillsReadContentResult = typeof SkillsReadContentResult.Type;

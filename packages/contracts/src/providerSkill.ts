import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Where a skill came from. Derived from the skill's path and the provider's
 * own scope label; see `resolveProviderSkillSourceKind` in `@t3tools/shared`,
 * which is the only implementation.
 *
 * Lives here rather than beside `ServerProviderSkill` so settings can key a
 * disabled skill on it without `settings.ts` importing `server.ts`.
 */
export const ProviderSkillSourceKind = Schema.Literals([
  "app",
  "repo",
  "project",
  "personal",
  "system",
  "other",
]);
export type ProviderSkillSourceKind = typeof ProviderSkillSourceKind.Type;

/**
 * Why a skill is off. `"provider"` means the provider's own configuration
 * switched it off and T3 Code cannot switch it back on; `"settings"` means the
 * user switched it off in T3 Code and the provider is untouched, so the agent
 * may still start the skill on its own.
 */
export const ProviderSkillDisabledBy = Schema.Literals(["provider", "settings"]);
export type ProviderSkillDisabledBy = typeof ProviderSkillDisabledBy.Type;

/**
 * How a disabled skill is stored. Deliberately not the skill's path: a path
 * moves with a worktree checkout and with a provider upgrade that reshuffles
 * its bundled skills, and the disable has to survive both. Two providers that
 * report the same source kind and name are one key, so one switch is one
 * decision.
 *
 * Names are stored trimmed and compared case-insensitively, matching the
 * picker's dedupe.
 */
export const ProviderSkillKey = Schema.Struct({
  source: ProviderSkillSourceKind,
  name: TrimmedNonEmptyString,
});
export type ProviderSkillKey = typeof ProviderSkillKey.Type;

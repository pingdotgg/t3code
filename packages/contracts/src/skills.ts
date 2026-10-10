import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillScope = Schema.Literals(["project", "global"]);
export type SkillScope = typeof SkillScope.Type;

export const SkillListInput = Schema.Struct({
  /** A project whose own skill folders are read besides the global ones. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SkillListInput = typeof SkillListInput.Type;

/**
 * How one agent reaches a skill. `direct`: it reads a real folder holding the skill (its own
 * folder, or one shared with other agents). `link`: a link in a folder it reads points at the
 * skill. `none`: it doesn't load this copy of the skill, because it can't see it, because
 * another skill of the same name comes first in its folders, or because its own settings switch
 * the skill off.
 */
export const SkillAgentState = Schema.Literals(["direct", "link", "none"]);
export type SkillAgentState = typeof SkillAgentState.Type;

export const SkillAgentAccess = Schema.Struct({
  /** The enabled provider instance this is about. Instances of unknown drivers are never listed. */
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  state: SkillAgentState,
  /** Where the agent reads the skill from, or for `none` where it looks for skills. */
  folder: Schema.String,
});
export type SkillAgentAccess = typeof SkillAgentAccess.Type;

/** Another skill with the same name, and whether its SKILL.md text is identical. */
export const SkillCopy = Schema.Struct({
  scope: SkillScope,
  /** The same display path as `SkillSummary.home`. */
  home: Schema.String,
  same: Schema.Boolean,
});
export type SkillCopy = typeof SkillCopy.Type;

export const SkillSummary = Schema.Struct({
  /** The skill's folder name, which is what an agent invokes it by. */
  name: Schema.String,
  scope: SkillScope,
  /** Where the files really are, after following links: relative to the project, or `~/…`. */
  home: Schema.String,
  /** The description cut to 160 characters, with a trailing `…` when it was cut. */
  description: Schema.String,
  /** SKILL.md's header can't be read the way Claude Code reads it, so Claude skips the skill. */
  invalidHeader: Schema.optional(Schema.Boolean),
  /** The other skills with the same name, in either scope. */
  copies: Schema.Array(SkillCopy),
  access: Schema.Array(SkillAgentAccess),
});
export type SkillSummary = typeof SkillSummary.Type;

/** A skill folder that exists but couldn't be read. */
export const SkillFolderProblem = Schema.Struct({
  scope: SkillScope,
  /** The same label as `SkillAgentAccess.folder`. */
  folder: Schema.String,
});
export type SkillFolderProblem = typeof SkillFolderProblem.Type;

export const SkillListResult = Schema.Struct({
  skills: Schema.Array(SkillSummary),
  /** Folders that couldn't be read; a folder that doesn't exist isn't one. */
  unreadable: Schema.Array(SkillFolderProblem),
});
export type SkillListResult = typeof SkillListResult.Type;

export const SkillGetInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  scope: SkillScope,
  name: TrimmedNonEmptyString,
  /** The `home` the list returned, to tell apart two skills that share a name. */
  home: TrimmedNonEmptyString,
});
export type SkillGetInput = typeof SkillGetInput.Type;

export const SkillFile = Schema.Struct({
  /** Relative to the skill's folder. */
  path: Schema.String,
  size: NonNegativeInt,
  executable: Schema.Boolean,
});
export type SkillFile = typeof SkillFile.Type;

export const SkillGetResult = Schema.Struct({
  /** Absolute path of the skill's folder; null when the skill wasn't found. */
  home: Schema.NullOr(Schema.String),
  /** The whole description, which the list cuts short. */
  description: Schema.String,
  /** SKILL.md text; null when it is missing or too large to show. */
  contents: Schema.NullOr(Schema.String),
  /** Files under the home, up to a limit. */
  files: Schema.Array(SkillFile),
  /** Some files aren't listed: there were more files, folders or entries than the limits allow. */
  filesTruncated: Schema.Boolean,
});
export type SkillGetResult = typeof SkillGetResult.Type;

/**
 * A skill read that couldn't be carried out, as opposed to a folder with no skills: a project's
 * folders are only read when the environment knows the folder as a project.
 */
export class SkillRequestError extends Schema.TaggedError<SkillRequestError>()(
  "SkillRequestError",
  {
    reason: Schema.Literals(["projectNotRegistered"]),
  },
) {
  override get message(): string {
    return "That folder isn't a project in this environment.";
  }
}

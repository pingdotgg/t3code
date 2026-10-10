import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Installing skills from a source, as `npx skills` does: the server runs the
 * `skills` CLI (vercel-labs/skills), so skills land in the same folders and
 * lock files a terminal install would write. Turning skills on or off stays in
 * `ServerSettings.disabledSkills`; this only adds and removes skill folders.
 */

/** Where an install goes: the environment's home folders, or a registered project. */
export const SkillInstallTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("environment") }),
  Schema.Struct({ kind: Schema.Literal("project"), cwd: TrimmedNonEmptyString }),
]);
export type SkillInstallTarget = typeof SkillInstallTarget.Type;

/**
 * What a user pastes: `owner/repo`, a git or GitHub tree URL, or an absolute
 * path on the environment. Never an option, which the CLI would parse as one.
 */
export const SkillSource = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((source: string) =>
    source.startsWith("-") ? "A source can't start with a dash." : true,
  ),
);

/** A skill's folder name, the name agents invoke it by, as the CLI sanitizes it. */
export const InstalledSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[a-z0-9._][a-z0-9._-]*$/),
);
export type InstalledSkillName = typeof InstalledSkillName.Type;

export const SkillFileEntry = Schema.Struct({
  /** Relative to the skill's folder, with `/` separators. */
  path: Schema.String,
  size: NonNegativeInt,
  executable: Schema.Boolean,
});
export type SkillFileEntry = typeof SkillFileEntry.Type;

export const SkillPreviewInput = Schema.Struct({ source: SkillSource });
export type SkillPreviewInput = typeof SkillPreviewInput.Type;

export const SkillPreviewItem = Schema.Struct({
  name: InstalledSkillName,
  description: Schema.String,
  /** Up to a limit; `filesTruncated` says when some were left out. */
  files: Schema.Array(SkillFileEntry),
  filesTruncated: Schema.Boolean,
  /** Some file is executable or a script, which an agent may run. */
  scripts: Schema.Boolean,
});
export type SkillPreviewItem = typeof SkillPreviewItem.Type;

export const SkillPreviewResult = Schema.Struct({ skills: Schema.Array(SkillPreviewItem) });
export type SkillPreviewResult = typeof SkillPreviewResult.Type;

export const SkillInstallInput = Schema.Struct({
  source: SkillSource,
  skills: Schema.Array(InstalledSkillName).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  target: SkillInstallTarget,
});
export type SkillInstallInput = typeof SkillInstallInput.Type;

/** One skill an `installed` lock entry names, to update or remove. */
export const InstalledSkillInput = Schema.Struct({
  name: InstalledSkillName,
  target: SkillInstallTarget,
});
export type InstalledSkillInput = typeof InstalledSkillInput.Type;

export const SkillInstallOutcome = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["installed", "skipped", "failed"]),
  error: Schema.optional(Schema.String),
});
export type SkillInstallOutcome = typeof SkillInstallOutcome.Type;

export const SkillInstallResult = Schema.Struct({ outcomes: Schema.Array(SkillInstallOutcome) });
export type SkillInstallResult = typeof SkillInstallResult.Type;

export const SkillInspectInput = Schema.Struct({
  /** A project checkout whose skills are inspected besides the environment's. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SkillInspectInput = typeof SkillInspectInput.Type;

/**
 * One SKILL.md an enabled agent reported, keyed by that path. The server
 * finds the paths itself, so a client can't point it at other files.
 */
export const SkillFolderInfo = Schema.Struct({
  /** The SKILL.md path the agent reported. */
  path: Schema.String,
  /** The skill's folder after following links, for viewing its files. */
  folder: Schema.String,
  /** SHA-256 of SKILL.md, so two copies of a name can be compared. */
  hash: Schema.String,
  scripts: Schema.Boolean,
  /** Set when the `skills` CLI installed this folder: its lock names the source. */
  installed: Schema.optional(
    Schema.Struct({
      target: SkillInstallTarget,
      /** `owner/repo`, a URL or a path, as the lock records it. */
      source: Schema.String,
    }),
  ),
});
export type SkillFolderInfo = typeof SkillFolderInfo.Type;

export const SkillInspectResult = Schema.Struct({ folders: Schema.Array(SkillFolderInfo) });
export type SkillInspectResult = typeof SkillInspectResult.Type;

export class SkillLibraryError extends Schema.TaggedError<SkillLibraryError>()(
  "SkillLibraryError",
  {
    reason: Schema.Literals([
      /** The CLI failed; `message` carries what it printed. */
      "cliFailed",
      /** The source has no skills the CLI could find. */
      "noSkills",
      /** The project isn't one of this environment's projects. */
      "projectNotRegistered",
      /** Only skills the CLI installed (with a lock entry) can be updated or removed. */
      "notInstalled",
    ]),
    message: Schema.String,
  },
) {}

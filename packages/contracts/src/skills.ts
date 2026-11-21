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

/**
 * A skill as the `skills` CLI names it: the `name` in its SKILL.md, which the
 * CLI matches `--skill` against and keys its lock files by. Its folder (and
 * the name agents invoke it by) is that name sanitized, so `Git Review` lives
 * in `git-review`. Either form identifies an installed skill.
 */
export const InstalledSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.makeFilter((name: string) =>
    name.startsWith("-") ? "A skill name can't start with a dash." : true,
  ),
);
export type InstalledSkillName = typeof InstalledSkillName.Type;

export const SkillFileEntry = Schema.Struct({
  /** Relative to the skill's folder, with `/` separators. */
  path: Schema.String,
  size: NonNegativeInt,
  executable: Schema.Boolean,
  /** A file an agent could run: executable, under `bin/`, or a script by its extension. */
  script: Schema.Boolean,
});
export type SkillFileEntry = typeof SkillFileEntry.Type;

export const SkillPreviewInput = Schema.Struct({ source: SkillSource });
export type SkillPreviewInput = typeof SkillPreviewInput.Type;

export const SkillPreviewItem = Schema.Struct({
  /** What to pass to install: the CLI's name for the skill. */
  name: InstalledSkillName,
  /** The folder it installs into, the name agents invoke it by. */
  folder: TrimmedNonEmptyString,
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

/** The most skills one install takes; a bigger pack installs in several goes. */
export const MAX_SKILLS_PER_INSTALL = 200;

export const SkillInstallInput = Schema.Struct({
  source: SkillSource,
  skills: Schema.Array(InstalledSkillName).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SKILLS_PER_INSTALL),
  ),
  target: SkillInstallTarget,
});
export type SkillInstallInput = typeof SkillInstallInput.Type;

/**
 * One skill at a level, by the name agents know it by: to update one the CLI
 * installed, or to remove one from the agents' skill folders there.
 */
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

/**
 * Copying a skill to another environment: the source environment packs the
 * folder an agent found it in, the client hands the bundle to each target.
 * Bounded, since the bundle crosses the WebSocket whole.
 */
export const MAX_SKILL_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_FILES = 500;

export const SkillBundleFile = Schema.Struct({
  /** Relative to the skill's folder, with `/` separators. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  /** The file's bytes as base64. */
  contents: Schema.String,
  executable: Schema.Boolean,
});
export type SkillBundleFile = typeof SkillBundleFile.Type;

export const SkillBundle = Schema.Struct({
  /** The folder name the skill is invoked by. */
  folder: InstalledSkillName,
  files: Schema.Array(SkillBundleFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_SKILL_BUNDLE_FILES),
  ),
  /**
   * Set when the `skills` CLI installed the skill from a remote source: the
   * target reinstalls from there, so the copy can be updated too, and falls
   * back to the files when that fails.
   */
  install: Schema.optional(
    Schema.Struct({ source: SkillSource, skill: InstalledSkillName, fullDepth: Schema.Boolean }),
  ),
});
export type SkillBundle = typeof SkillBundle.Type;

/** A skill an agent reports on this environment, by name, at the level it lives. */
export const SkillExportInput = Schema.Struct({
  name: InstalledSkillName,
  target: SkillInstallTarget,
});
export type SkillExportInput = typeof SkillExportInput.Type;

export const SkillImportInput = Schema.Struct({
  bundle: SkillBundle,
  target: SkillInstallTarget,
});
export type SkillImportInput = typeof SkillImportInput.Type;

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
  /** The folder's files, up to a limit, for viewing them with `projects.readFile`. */
  files: Schema.Array(SkillFileEntry),
  filesTruncated: Schema.Boolean,
  scripts: Schema.Boolean,
  /**
   * The level this copy belongs to when the agent found it directly in one of
   * the agents' skill folders, at home or in the project, so it can be
   * removed. Absent for a plugin's or an agent's built-in skills.
   */
  location: Schema.optional(SkillInstallTarget),
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
      /**
       * Nothing to change: update needs a skill the CLI installed (with a lock
       * entry), and remove a skill in the agents' skill folders at that level.
       */
      "notInstalled",
      /** A skill to copy is bigger than a bundle may be, or its folder can't be read. */
      "tooLarge",
      /** A skill with that name is already at the target. */
      "exists",
    ]),
    message: Schema.String,
  },
) {}

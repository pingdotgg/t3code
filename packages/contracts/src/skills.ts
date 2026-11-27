import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SKILL_PATH_MAX_LENGTH = 512;
const SKILL_NAME_MAX_LENGTH = 128;
const SKILL_MAX_BUNDLE_SKILLS = 100;
const SKILL_MAX_FILES_PER_SKILL = 200;

export const SKILL_INJECT_TARGETS = ["agents", "codex", "claude", "antigravity", "pi"] as const;

export const SkillInjectTarget = Schema.Literals(SKILL_INJECT_TARGETS);
export type SkillInjectTarget = typeof SkillInjectTarget.Type;

export const SkillLibraryEntry = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_NAME_MAX_LENGTH)),
  description: Schema.optional(Schema.String),
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  filesCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type SkillLibraryEntry = typeof SkillLibraryEntry.Type;

export const SkillLibraryListInput = Schema.Struct({
  libraryPath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  ),
});
export type SkillLibraryListInput = typeof SkillLibraryListInput.Type;

export const SkillLibraryListResult = Schema.Struct({
  libraryPath: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  skills: Schema.Array(SkillLibraryEntry),
});
export type SkillLibraryListResult = typeof SkillLibraryListResult.Type;

export const SkillBundleFile = Schema.Struct({
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  contentBase64: Schema.String,
});
export type SkillBundleFile = typeof SkillBundleFile.Type;

export const SkillBundle = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_NAME_MAX_LENGTH)),
  files: Schema.Array(SkillBundleFile).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SKILL_MAX_FILES_PER_SKILL),
  ),
});
export type SkillBundle = typeof SkillBundle.Type;

export const SkillLibraryReadBundleInput = Schema.Struct({
  libraryPath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  ),
  names: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_NAME_MAX_LENGTH))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SKILL_MAX_BUNDLE_SKILLS),
  ),
});
export type SkillLibraryReadBundleInput = typeof SkillLibraryReadBundleInput.Type;

export const SkillLibraryReadBundleResult = Schema.Struct({
  libraryPath: TrimmedNonEmptyString,
  skills: Schema.Array(SkillBundle),
});
export type SkillLibraryReadBundleResult = typeof SkillLibraryReadBundleResult.Type;

export const SkillInjectInput = Schema.Struct({
  targets: Schema.Array(SkillInjectTarget).check(Schema.isMinLength(1)),
  skills: Schema.Array(SkillBundle).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SKILL_MAX_BUNDLE_SKILLS),
  ),
  overwrite: Schema.optional(Schema.Boolean),
});
export type SkillInjectInput = typeof SkillInjectInput.Type;

export const SkillInjectItemStatus = Schema.Literals(["injected", "skipped", "error"]);
export type SkillInjectItemStatus = typeof SkillInjectItemStatus.Type;

export const SkillInjectItemResult = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  target: SkillInjectTarget,
  destinationPath: TrimmedNonEmptyString,
  status: SkillInjectItemStatus,
  message: Schema.optional(Schema.String),
});
export type SkillInjectItemResult = typeof SkillInjectItemResult.Type;

export const SkillInjectResult = Schema.Struct({
  results: Schema.Array(SkillInjectItemResult),
});
export type SkillInjectResult = typeof SkillInjectResult.Type;

export class SkillLibraryError extends Schema.TaggedError<SkillLibraryError>()(
  "SkillLibraryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

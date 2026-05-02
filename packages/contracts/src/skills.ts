import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const SKILL_SEARCH_LIMIT_MAX = 100;
const SKILL_SEARCH_QUERY_MAX_LENGTH = 128;
const SKILL_ROOTS_MAX = 32;
const SKILL_PATH_MAX_LENGTH = 4096;

export const SkillSource = Schema.Literals(["workspace", "codex-home", "extra-root"]);
export type SkillSource = typeof SkillSource.Type;

export const SkillSearchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_SEARCH_QUERY_MAX_LENGTH)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(SKILL_SEARCH_LIMIT_MAX)),
  codexHomePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  ),
  extraRoots: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH))).check(
      Schema.isMaxLength(SKILL_ROOTS_MAX),
    ),
  ),
});
export type SkillSearchInput = typeof SkillSearchInput.Type;

export const SkillSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  skillPath: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  rootPath: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_PATH_MAX_LENGTH)),
  source: SkillSource,
});
export type SkillSummary = typeof SkillSummary.Type;

export const SkillSearchResult = Schema.Struct({
  skills: Schema.Array(SkillSummary),
  truncated: Schema.Boolean,
});
export type SkillSearchResult = typeof SkillSearchResult.Type;

export class SkillSearchError extends Schema.TaggedErrorClass<SkillSearchError>()(
  "SkillSearchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

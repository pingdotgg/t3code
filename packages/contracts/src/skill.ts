import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SkillReadFileInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  skillName: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type SkillReadFileInput = typeof SkillReadFileInput.Type;

export const SkillReadFileResult = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  skillPath: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  contents: Schema.optional(Schema.String),
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type SkillReadFileResult = typeof SkillReadFileResult.Type;

export const SkillReadFileFailure = Schema.Literals([
  "message_not_found",
  "skill_not_resolved",
  "path_outside_skill",
  "path_not_file",
  "unsupported_file",
  "operation_failed",
]);
export type SkillReadFileFailure = typeof SkillReadFileFailure.Type;

export class SkillReadFileError extends Schema.TaggedErrorClass<SkillReadFileError>()(
  "SkillReadFileError",
  {
    message: TrimmedNonEmptyString,
    failure: SkillReadFileFailure,
    skillName: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
  },
) {}

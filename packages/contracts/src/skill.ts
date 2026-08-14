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

type SkillReadFileFailureContext = {
  readonly failure: SkillReadFileFailure;
  readonly skillName: string;
  readonly relativePath: string;
  readonly cause?: unknown;
};

function skillReadFileErrorMessage({
  failure,
  skillName,
  relativePath,
}: SkillReadFileFailureContext): string {
  switch (failure) {
    case "message_not_found":
      return `The user message for skill '${skillName}' is no longer available.`;
    case "skill_not_resolved":
      return `Skill '${skillName}' is no longer available.`;
    case "path_outside_skill":
      return `The requested path '${relativePath}' is outside skill '${skillName}'.`;
    case "path_not_file":
      return `The requested path '${relativePath}' is not an available file in skill '${skillName}'.`;
    case "unsupported_file":
      return `The requested file '${relativePath}' in skill '${skillName}' cannot be shown as text.`;
    case "operation_failed":
      return `T3 Code could not read '${relativePath}' from skill '${skillName}'.`;
  }
}

export class SkillReadFileError extends Schema.TaggedErrorClass<SkillReadFileError>()(
  "SkillReadFileError",
  {
    message: TrimmedNonEmptyString,
    failure: SkillReadFileFailure,
    skillName: TrimmedNonEmptyString,
    relativePath: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: SkillReadFileFailureContext) {
    super({
      ...props,
      message: skillReadFileErrorMessage(props),
    } as any);
  }
}

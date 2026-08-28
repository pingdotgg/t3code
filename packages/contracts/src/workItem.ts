import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkItemTaskMode = Schema.Literals(["compound", "subtasks"]);
export type WorkItemTaskMode = typeof WorkItemTaskMode.Type;

export const WorkItemTaskSourceRef = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type WorkItemTaskSourceRef = typeof WorkItemTaskSourceRef.Type;

export const WorkItemTaskInput = Schema.Struct({
  projectId: ProjectId,
  mode: WorkItemTaskMode,
  items: Schema.Array(WorkItemTaskSourceRef).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type WorkItemTaskInput = typeof WorkItemTaskInput.Type;

export const WORK_ITEM_TASK_PROMPT_MAX_LENGTH = 65_536;

export const WorkItemTaskResult = Schema.Struct({
  prompt: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(WORK_ITEM_TASK_PROMPT_MAX_LENGTH),
  ),
  generated: Schema.Boolean,
});
export type WorkItemTaskResult = typeof WorkItemTaskResult.Type;

export class WorkItemTaskError extends Schema.TaggedErrorClass<WorkItemTaskError>()(
  "WorkItemTaskError",
  {
    operation: Schema.Literals(["read-source", "generate"]),
    source: WorkItemTaskSourceRef,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work item task generation failed during ${this.operation}: ${this.detail}`;
  }
}

export const WorkItemMatchRelationship = Schema.Literals(["related", "duplicate"]);
export type WorkItemMatchRelationship = typeof WorkItemMatchRelationship.Type;

export const WorkItemMatchInput = Schema.Struct({
  projectId: ProjectId,
  relationship: WorkItemMatchRelationship,
  source: WorkItemTaskSourceRef,
});
export type WorkItemMatchInput = typeof WorkItemMatchInput.Type;

export const WorkItemMatch = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  provider: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  confidence: Schema.Literals(["high", "medium"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
});
export type WorkItemMatch = typeof WorkItemMatch.Type;

export const WorkItemMatchResult = Schema.Struct({
  matches: Schema.Array(WorkItemMatch).check(Schema.isMaxLength(5)),
});
export type WorkItemMatchResult = typeof WorkItemMatchResult.Type;

export class WorkItemMatchError extends Schema.TaggedErrorClass<WorkItemMatchError>()(
  "WorkItemMatchError",
  {
    operation: Schema.Literals(["read-source", "list-candidates", "read-candidate", "generate"]),
    source: WorkItemTaskSourceRef,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work item matching failed during ${this.operation}: ${this.detail}`;
  }
}

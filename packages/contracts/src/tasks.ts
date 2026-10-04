import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const TaskProvider = Schema.Literals(["github", "linear"]);
export type TaskProvider = typeof TaskProvider.Type;
export const TaskSource = Schema.Struct({
  provider: TaskProvider,
  baseUrl: Schema.String,
  scope: Schema.String,
});
export type TaskSource = typeof TaskSource.Type;
export const ExternalTask = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: Schema.String,
  assignee: Schema.String,
  labels: Schema.Array(Schema.String),
  priority: Schema.String,
  comments: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.String, body: Schema.String }),
  ),
  relationships: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })),
  branchName: Schema.optional(Schema.String),
});
export type ExternalTask = typeof ExternalTask.Type;
export const TaskField = Schema.Literals([
  "title",
  "description",
  "status",
  "assignee",
  "labels",
  "priority",
]);
export type TaskField = typeof TaskField.Type;
export const TaskLink = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  provider: TaskProvider,
  taskUrl: Schema.String,
  taskKey: Schema.String,
  title: Schema.String,
});
export const TaskRequest = Schema.Struct({
  projectId: ProjectId,
  action: Schema.Literals([
    "status",
    "list",
    "detail",
    "create",
    "update",
    "comment",
    "projects",
    "items",
    "link",
    "links",
    "unlink",
  ]),
  query: Schema.optional(Schema.String),
  filter: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  changes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  comment: Schema.optional(Schema.String),
  /** Reuse this ID until an external write is confirmed. An uncertain write cannot be retried. */
  operationId: Schema.optional(Schema.String),
  link: Schema.optional(TaskLink),
  threadId: Schema.optional(ThreadId),
});
export type TaskRequest = typeof TaskRequest.Type;
export const TaskResult = Schema.Struct({
  source: Schema.NullOr(TaskSource),
  tasks: Schema.Array(ExternalTask),
  nextCursor: Schema.NullOr(Schema.String),
  editableFields: Schema.Array(TaskField),
  canComment: Schema.Boolean,
  fieldOptions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
    ),
  ),
  links: Schema.Array(TaskLink),
});
export type TaskResult = typeof TaskResult.Type;
export const TaskConfigureInput = Schema.Struct({
  projectId: ProjectId,
  source: Schema.NullOr(TaskSource),
  token: Schema.optional(Schema.Redacted(Schema.String)),
});
export type TaskConfigureInput = typeof TaskConfigureInput.Type;
export class TaskIntegrationError extends Schema.TaggedError<TaskIntegrationError>()(
  "TaskIntegrationError",
  {
    code: Schema.Literals([
      "authentication",
      "rate-limit",
      "unavailable",
      "invalid",
      "uncertain-write",
      "conflict",
    ]),
    message: Schema.String,
  },
) {}

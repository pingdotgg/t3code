import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TaskDocumentId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("TaskDocumentId"),
);
export type TaskDocumentId = typeof TaskDocumentId.Type;
export const TASK_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const Contents = Schema.String.check(Schema.isMaxLength(TASK_DOCUMENT_MAX_BYTES));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const TaskDocumentRegistration = Schema.Struct({
  taskDocumentId: TaskDocumentId,
  canonicalPath: Schema.String,
  locatorVersion: NonNegativeInt,
  observedFileId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  registered: Schema.Boolean,
});
export type TaskDocumentRegistration = typeof TaskDocumentRegistration.Type;
export const TaskDocumentSummary = Schema.Struct({
  ...TaskDocumentRegistration.fields,
  title: Schema.String,
  state: Schema.NullOr(Schema.String),
  pinned: Schema.Boolean,
  availability: Schema.Literals([
    "available",
    "missing",
    "identity-changed",
    "unavailable",
    "unregistered",
  ]),
  revision: Schema.NullOr(Revision),
});
export type TaskDocumentSummary = typeof TaskDocumentSummary.Type;
export const OpenTaskDocument = Schema.Struct({
  summary: TaskDocumentSummary,
  contents: Contents,
  revision: Revision,
});
export type OpenTaskDocument = typeof OpenTaskDocument.Type;
export const TaskDocumentRef = Schema.Struct({ taskDocumentId: TaskDocumentId });
export type TaskDocumentRef = typeof TaskDocumentRef.Type;
export const RegisterTaskDocumentInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type RegisterTaskDocumentInput = typeof RegisterTaskDocumentInput.Type;
/** The id is minted by the caller so a retried creation finds its own file instead of making another. */
export const CreateTaskDocumentInput = Schema.Struct({
  taskDocumentId: TaskDocumentId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(20_000)),
  directory: Schema.optional(TrimmedNonEmptyString),
});
export type CreateTaskDocumentInput = typeof CreateTaskDocumentInput.Type;
export const TaskDocumentFolder = Schema.Struct({ directory: Schema.String });
export type TaskDocumentFolder = typeof TaskDocumentFolder.Type;
export const SaveTaskDocumentInput = Schema.Struct({
  ...TaskDocumentRef.fields,
  locatorVersion: NonNegativeInt,
  expectedRevision: Revision,
  baseContents: Contents,
  contents: Contents,
});
export type SaveTaskDocumentInput = typeof SaveTaskDocumentInput.Type;
export const RelinkTaskDocumentInput = Schema.Struct({
  ...TaskDocumentRef.fields,
  locatorVersion: NonNegativeInt,
  path: TrimmedNonEmptyString,
  reconcileIdentity: Schema.optional(Schema.Boolean),
});
export type RelinkTaskDocumentInput = typeof RelinkTaskDocumentInput.Type;
export const TaskDocumentRecoveryRef = Schema.Struct({
  ...TaskDocumentRef.fields,
  recoveryId: Schema.String.check(Schema.isUUID()),
});
export type TaskDocumentRecoveryRef = typeof TaskDocumentRecoveryRef.Type;
export const TaskDocumentRecovery = Schema.Struct({
  ...TaskDocumentRecoveryRef.fields,
  expectedRevision: Revision,
  locatorVersion: NonNegativeInt,
  baseContents: Contents,
  contents: Contents,
  disk: Schema.NullOr(OpenTaskDocument),
});
export type TaskDocumentRecovery = typeof TaskDocumentRecovery.Type;
export class TaskDocumentError extends Schema.TaggedError<TaskDocumentError>()(
  "TaskDocumentError",
  {
    recovery: Schema.optionalKey(TaskDocumentRecoveryRef),
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.Literals([
      "not-registered",
      "missing",
      "duplicate-path",
      "duplicate-id",
      "identity-changed",
      "stale-locator",
      "too-large",
      "unsupported",
      "limit",
      "io",
      "recovery-unavailable",
      "invalid-base",
    ]),
  },
) {
  override get message() {
    return `Task document operation failed: ${this.reason}.`;
  }
}
export class TaskDocumentConflict extends Schema.TaggedError<TaskDocumentConflict>()(
  "TaskDocumentConflict",
  {
    ...TaskDocumentRecoveryRef.fields,
    currentRevision: Schema.NullOr(Revision),
  },
) {
  override get message() {
    return "The task document changed. The draft was retained for recovery.";
  }
}
export const TaskDocumentOperationError = Schema.Union([TaskDocumentError, TaskDocumentConflict]);
export type TaskDocumentOperationError = typeof TaskDocumentOperationError.Type;
/** Notices coalesce; refresh the catalogue rather than only this row. */
export const TaskDocumentNotice = Schema.Struct({
  taskDocumentId: TaskDocumentId,
});
export type TaskDocumentNotice = typeof TaskDocumentNotice.Type;

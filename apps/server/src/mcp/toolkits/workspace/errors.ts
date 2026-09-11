import * as Schema from "effect/Schema";

export const WorkspaceMcpErrorCode = Schema.Literals([
  "not_found",
  "invalid_input",
  "forbidden",
  "conflict",
  "internal",
]);
export type WorkspaceMcpErrorCode = typeof WorkspaceMcpErrorCode.Type;

export class WorkspaceMcpError extends Schema.TaggedError<WorkspaceMcpError>()(
  "WorkspaceMcpError",
  {
    code: WorkspaceMcpErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

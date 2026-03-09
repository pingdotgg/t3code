import { Schema } from "effect";

export class VcsCommandError extends Schema.TaggedErrorClass<VcsCommandError>()("VcsCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `VCS command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export class VcsUnsupportedError extends Schema.TaggedErrorClass<VcsUnsupportedError>()(
  "VcsUnsupportedError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported VCS operation in ${this.operation} (${this.cwd}) - ${this.detail}`;
  }
}

export type VcsServiceError = VcsCommandError | VcsUnsupportedError;

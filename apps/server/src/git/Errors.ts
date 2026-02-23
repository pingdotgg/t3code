import { Schema } from "effect";

/**
 * GitCommandError - Git command execution failed.
 */
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

import { Schema } from "effect";
import type { TextGenerationError } from "../git/Errors.ts";

/**
 * JiraCliError - Jira CLI execution or authentication failed.
 */
export class JiraCliError extends Schema.TaggedErrorClass<JiraCliError>()("JiraCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Jira CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * JiraManagerError - Jira workflow orchestration failed.
 */
export class JiraManagerError extends Schema.TaggedErrorClass<JiraManagerError>()(
  "JiraManagerError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Jira manager failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * JiraManagerServiceError - Errors emitted by Jira workflow orchestration.
 */
export type JiraManagerServiceError = JiraCliError | JiraManagerError | TextGenerationError;

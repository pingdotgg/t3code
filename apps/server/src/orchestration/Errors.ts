import { SchemaIssue, Schema } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class OrchestrationCommandInvariantError extends Schema.TaggedErrorClass<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedErrorClass<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedErrorClass<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export class OrchestrationListenerCallbackError extends Schema.TaggedErrorClass<OrchestrationListenerCallbackError>()(
  "OrchestrationListenerCallbackError",
  {
    listener: Schema.Literals(["read-model", "domain-event"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Orchestration ${this.listener} listener failed: ${this.detail}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError;
export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

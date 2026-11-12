/**
 * Orchestrator error taxonomy.
 *
 * Extracted from Orchestrator.ts: these tagged errors and their guards form the
 * dispatch/authorisation surface and have no dependency on the orchestrator's
 * internals, so they live on their own. Orchestrator.ts re-exports them to keep
 * its public surface unchanged.
 */
import {
  CommandId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorThreadAlreadyExistsError extends Schema.TaggedError<OrchestratorThreadAlreadyExistsError>()(
  "OrchestratorThreadAlreadyExistsError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} already exists. Use a new thread id.`;
  }
}

export class OrchestratorCommandRejectedError extends Schema.TaggedError<OrchestratorCommandRejectedError>()(
  "OrchestratorCommandRejectedError",
  { commandId: CommandId, commandType: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Orchestration command ${this.commandType} (${this.commandId}) was rejected before commit.`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedError<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export const isOrchestratorProjectionError = Schema.is(OrchestratorProjectionError);

export class OrchestratorDomainEventStreamError extends Schema.TaggedError<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedError<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorSubagentThreadReadOnlyError extends Schema.TaggedError<OrchestratorSubagentThreadReadOnlyError>()(
  "OrchestratorSubagentThreadReadOnlyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return "This subagent is run by its provider and cannot take messages. Message the parent thread instead.";
  }
}

export class OrchestratorThreadAboveModeLimitError extends Schema.TaggedError<OrchestratorThreadAboveModeLimitError>()(
  "OrchestratorThreadAboveModeLimitError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    mode: Schema.Literals(["runtime", "interaction"]),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} now runs in ${this.runtimeMode}/${this.interactionMode} mode, above what this caller may change.`;
  }
}

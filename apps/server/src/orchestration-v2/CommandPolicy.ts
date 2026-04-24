import {
  CommandId,
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  ProviderKind,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export const MessageDispatchDecisionV2 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start_run"),
    modelSelection: ModelSelection,
  }),
  Schema.Struct({
    type: Schema.Literal("steer_active"),
    targetRunId: RunId,
    providerTurnId: ProviderTurnId,
  }),
  Schema.Struct({
    type: Schema.Literal("restart_active"),
    targetRunId: RunId,
    interruptProviderTurnId: ProviderTurnId,
  }),
  Schema.Struct({
    type: Schema.Literal("queue_after_active"),
    activeRunId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("switch_provider"),
    fromProvider: ProviderKind,
    toModelSelection: ModelSelection,
  }),
]);
export type MessageDispatchDecisionV2 = typeof MessageDispatchDecisionV2.Type;

export class CommandPolicyMessageDispatchError extends Schema.TaggedErrorClass<CommandPolicyMessageDispatchError>()(
  "CommandPolicyMessageDispatchError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to choose message dispatch policy for command ${this.commandId}.`;
  }
}

export class CommandPolicyUnsupportedError extends Schema.TaggedErrorClass<CommandPolicyUnsupportedError>()(
  "CommandPolicyUnsupportedError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    requestedMode: Schema.String,
    provider: ProviderKind,
  },
) {
  override get message(): string {
    return `${this.provider} cannot satisfy message dispatch mode ${this.requestedMode} for command ${this.commandId}.`;
  }
}

export const CommandPolicyV2Error = Schema.Union([
  CommandPolicyMessageDispatchError,
  CommandPolicyUnsupportedError,
]);
export type CommandPolicyV2Error = typeof CommandPolicyV2Error.Type;

export interface CommandPolicyV2Shape {
  readonly decideMessageDispatch: (input: {
    readonly commandId: CommandId;
    readonly projection: OrchestrationV2ThreadProjection;
    readonly requestedModelSelection?: ModelSelection;
    readonly requestedMode:
      | { readonly type: "steer_active"; readonly targetRunId: RunId }
      | { readonly type: "restart_active"; readonly targetRunId: RunId }
      | { readonly type: "queue_after_active" }
      | { readonly type: "start_immediately" };
    readonly capabilities: OrchestrationV2ProviderCapabilities;
  }) => Effect.Effect<MessageDispatchDecisionV2, CommandPolicyV2Error>;
}

export class CommandPolicyV2 extends Context.Service<CommandPolicyV2, CommandPolicyV2Shape>()(
  "t3/orchestration-v2/CommandPolicy",
) {}

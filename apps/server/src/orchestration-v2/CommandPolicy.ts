import {
  CommandId,
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
    fromProviderInstanceId: ProviderInstanceId,
    toModelSelection: ModelSelection,
  }),
]);
export type MessageDispatchDecisionV2 = typeof MessageDispatchDecisionV2.Type;

export const SteeringExecutionPolicyV2 = Schema.Literals(["active_steering", "interrupt_restart"]);
export type SteeringExecutionPolicyV2 = typeof SteeringExecutionPolicyV2.Type;

export const ForkExecutionPolicyV2 = Schema.Literals(["native_fork", "portable_context"]);
export type ForkExecutionPolicyV2 = typeof ForkExecutionPolicyV2.Type;

export const CommandPolicyCapability = Schema.Literals([
  "queued_messages",
  "active_steering",
  "interrupt",
  "interrupt_restart_steering",
  "native_fork",
  "fork_from_turn",
  "rollback",
  "rollback_snapshot",
  "context_handoff",
  "strong_terminal_status",
]);
export type CommandPolicyCapability = typeof CommandPolicyCapability.Type;

export class CommandPolicyMessageDispatchError extends Schema.TaggedErrorClass<CommandPolicyMessageDispatchError>()(
  "CommandPolicyMessageDispatchError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
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
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `${this.providerInstanceId} cannot satisfy message dispatch mode ${this.requestedMode} for command ${this.commandId}.`;
  }
}

export class CommandPolicyCapabilityUnsupportedError extends Schema.TaggedErrorClass<CommandPolicyCapabilityUnsupportedError>()(
  "CommandPolicyCapabilityUnsupportedError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    capability: CommandPolicyCapability,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.providerInstanceId} cannot satisfy ${this.capability} for command ${this.commandId}: ${this.detail}`;
  }
}

export const CommandPolicyV2Error = Schema.Union([
  CommandPolicyMessageDispatchError,
  CommandPolicyUnsupportedError,
  CommandPolicyCapabilityUnsupportedError,
]);
export type CommandPolicyV2Error = typeof CommandPolicyV2Error.Type;

interface CapabilityCheckInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}

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
  readonly ensureQueuedMessages: (
    input: CapabilityCheckInput,
  ) => Effect.Effect<void, CommandPolicyV2Error>;
  readonly decideSteeringExecution: (
    input: CapabilityCheckInput & {
      readonly forceRestart?: boolean;
    },
  ) => Effect.Effect<SteeringExecutionPolicyV2, CommandPolicyV2Error>;
  readonly ensureInterrupt: (
    input: CapabilityCheckInput,
  ) => Effect.Effect<void, CommandPolicyV2Error>;
  readonly ensureNativeFork: (
    input: CapabilityCheckInput & {
      readonly fromSpecificTurn: boolean;
    },
  ) => Effect.Effect<void, CommandPolicyV2Error>;
  readonly decideForkExecution: (
    input: CapabilityCheckInput & {
      readonly sameProvider: boolean;
      readonly hasStrongNativeSource: boolean;
      readonly fromSpecificTurn: boolean;
    },
  ) => Effect.Effect<ForkExecutionPolicyV2, CommandPolicyV2Error>;
  readonly ensureRollback: (
    input: CapabilityCheckInput,
  ) => Effect.Effect<void, CommandPolicyV2Error>;
  readonly ensureContextHandoff: (
    input: CapabilityCheckInput & {
      readonly strategy: "fork_delta_context" | "delta_context" | "full_thread_summary";
    },
  ) => Effect.Effect<void, CommandPolicyV2Error>;
}

export class CommandPolicyV2 extends Context.Service<CommandPolicyV2, CommandPolicyV2Shape>()(
  "t3/orchestration-v2/CommandPolicy/CommandPolicyV2",
) {}

function unsupported(
  input: CapabilityCheckInput,
  capability: CommandPolicyCapability,
  detail: string,
) {
  return new CommandPolicyCapabilityUnsupportedError({
    commandId: input.commandId,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    capability,
    detail,
  });
}

const ensureQueuedMessages: CommandPolicyV2Shape["ensureQueuedMessages"] = (input) =>
  input.capabilities.turns.supportsQueuedMessages
    ? Effect.void
    : Effect.fail(
        unsupported(
          input,
          "queued_messages",
          "providerInstanceId does not support app-owned queued turns",
        ),
      );

const decideSteeringExecution: CommandPolicyV2Shape["decideSteeringExecution"] = (input) => {
  if (!input.forceRestart && input.capabilities.turns.supportsActiveSteering) {
    return Effect.succeed("active_steering");
  }
  if (
    input.capabilities.turns.supportsInterrupt &&
    input.capabilities.turns.supportsSteeringByInterruptRestart
  ) {
    return Effect.succeed("interrupt_restart");
  }
  return Effect.fail(
    unsupported(
      input,
      input.capabilities.turns.supportsInterrupt ? "interrupt_restart_steering" : "active_steering",
      "providerInstanceId cannot steer active turns directly or by interrupt-and-restart",
    ),
  );
};

const ensureInterrupt: CommandPolicyV2Shape["ensureInterrupt"] = (input) =>
  input.capabilities.turns.supportsInterrupt
    ? Effect.void
    : Effect.fail(
        unsupported(input, "interrupt", "providerInstanceId does not support turn interrupts"),
      );

const ensureNativeFork: CommandPolicyV2Shape["ensureNativeFork"] = (input) => {
  if (!input.capabilities.threads.canForkThread) {
    return Effect.fail(
      unsupported(input, "native_fork", "providerInstanceId does not support native thread forks"),
    );
  }
  if (input.fromSpecificTurn && !input.capabilities.threads.canForkFromTurn) {
    return Effect.fail(
      unsupported(
        input,
        "fork_from_turn",
        "providerInstanceId cannot fork from a specific completed turn",
      ),
    );
  }
  if (input.capabilities.identity.nativeThreadIds !== "strong") {
    return Effect.fail(
      unsupported(
        input,
        "native_fork",
        "providerInstanceId does not expose strong native thread ids",
      ),
    );
  }
  return Effect.void;
};

const ensureRollback: CommandPolicyV2Shape["ensureRollback"] = (input) => {
  if (
    !input.capabilities.threads.canRollbackThread ||
    !input.capabilities.checkpointing.providerCanRollbackConversation
  ) {
    return Effect.fail(
      unsupported(input, "rollback", "providerInstanceId conversation rollback is unavailable"),
    );
  }
  if (!input.capabilities.checkpointing.providerRollbackReturnsSnapshot) {
    return Effect.fail(
      unsupported(
        input,
        "rollback_snapshot",
        "rollback must return a providerInstanceId thread snapshot",
      ),
    );
  }
  return Effect.void;
};

const ensureContextHandoff: CommandPolicyV2Shape["ensureContextHandoff"] = (input) => {
  if (!input.capabilities.context.canConsumeHandoffSummaries) {
    return Effect.fail(
      unsupported(input, "context_handoff", "providerInstanceId cannot consume handoff summaries"),
    );
  }
  if (!input.capabilities.context.acceptsSyntheticUserContext) {
    return Effect.fail(
      unsupported(
        input,
        "context_handoff",
        "providerInstanceId cannot receive synthetic user context",
      ),
    );
  }
  if (
    (input.strategy === "fork_delta_context" || input.strategy === "delta_context") &&
    !input.capabilities.context.supportsDeltaHandoff
  ) {
    return Effect.fail(
      unsupported(input, "context_handoff", "providerInstanceId does not support delta handoff"),
    );
  }
  if (
    input.strategy === "full_thread_summary" &&
    !input.capabilities.context.supportsFullThreadHandoff
  ) {
    return Effect.fail(
      unsupported(
        input,
        "context_handoff",
        "providerInstanceId does not support full-thread handoff",
      ),
    );
  }
  return Effect.void;
};

const decideForkExecution: CommandPolicyV2Shape["decideForkExecution"] = (input) => {
  const canForkNatively =
    input.sameProvider &&
    input.hasStrongNativeSource &&
    input.capabilities.threads.canForkThread &&
    (!input.fromSpecificTurn || input.capabilities.threads.canForkFromTurn) &&
    input.capabilities.identity.nativeThreadIds === "strong";

  if (canForkNatively) {
    return Effect.succeed("native_fork");
  }

  return ensureContextHandoff({
    commandId: input.commandId,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    capabilities: input.capabilities,
    strategy: "full_thread_summary",
  }).pipe(Effect.as("portable_context"));
};

const decideMessageDispatch: CommandPolicyV2Shape["decideMessageDispatch"] = (input) => {
  const activeRun = input.projection.runs.find(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
  const modelSelection = input.requestedModelSelection ?? input.projection.thread.modelSelection;

  switch (input.requestedMode.type) {
    case "steer_active": {
      if (activeRun?.id !== input.requestedMode.targetRunId) {
        return Effect.fail(
          new CommandPolicyUnsupportedError({
            commandId: input.commandId,
            threadId: input.projection.thread.id,
            requestedMode: input.requestedMode.type,
            providerInstanceId: modelSelection.instanceId,
          }),
        );
      }
      const providerTurnId =
        activeRun.activeAttemptId === null
          ? undefined
          : input.projection.providerTurns.find(
              (turn) =>
                turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
            )?.id;
      return providerTurnId === undefined
        ? Effect.fail(
            new CommandPolicyMessageDispatchError({
              commandId: input.commandId,
              threadId: input.projection.thread.id,
              cause: `No running providerInstanceId turn found for active run ${activeRun.id}.`,
            }),
          )
        : Effect.succeed({
            type: "steer_active",
            targetRunId: activeRun.id,
            providerTurnId,
          });
    }
    case "restart_active": {
      if (activeRun?.id !== input.requestedMode.targetRunId || activeRun.activeAttemptId === null) {
        return Effect.fail(
          new CommandPolicyUnsupportedError({
            commandId: input.commandId,
            threadId: input.projection.thread.id,
            requestedMode: input.requestedMode.type,
            providerInstanceId: modelSelection.instanceId,
          }),
        );
      }
      const providerTurnId = input.projection.providerTurns.find(
        (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
      )?.id;
      return providerTurnId === undefined
        ? Effect.fail(
            new CommandPolicyMessageDispatchError({
              commandId: input.commandId,
              threadId: input.projection.thread.id,
              cause: `No running providerInstanceId turn found for active run ${activeRun.id}.`,
            }),
          )
        : Effect.succeed({
            type: "restart_active",
            targetRunId: activeRun.id,
            interruptProviderTurnId: providerTurnId,
          });
    }
    case "queue_after_active":
      return activeRun === undefined
        ? Effect.succeed({ type: "start_run", modelSelection })
        : ensureQueuedMessages({
            commandId: input.commandId,
            threadId: input.projection.thread.id,
            providerInstanceId: modelSelection.instanceId,
            capabilities: input.capabilities,
          }).pipe(Effect.as({ type: "queue_after_active", activeRunId: activeRun.id }));
    case "start_immediately":
      if (activeRun === undefined) {
        return Effect.succeed({ type: "start_run", modelSelection });
      }
      return ensureQueuedMessages({
        commandId: input.commandId,
        threadId: input.projection.thread.id,
        providerInstanceId: modelSelection.instanceId,
        capabilities: input.capabilities,
      }).pipe(Effect.as({ type: "queue_after_active", activeRunId: activeRun.id }));
  }
};

export const layer: Layer.Layer<CommandPolicyV2> = Layer.succeed(CommandPolicyV2, {
  decideMessageDispatch,
  ensureQueuedMessages,
  decideSteeringExecution,
  ensureInterrupt,
  ensureNativeFork,
  decideForkExecution,
  ensureRollback,
  ensureContextHandoff,
});

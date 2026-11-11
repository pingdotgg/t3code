import {
  type ChatAttachment,
  CommandId,
  type OrchestrationV2Command,
  OrchestrationV2ProviderCapabilities,
  type OrchestrationV2GoalCommand,
  type OrchestrationV2ProviderGoalStatus,
  type OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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

export class CommandPolicyCapabilityUnsupportedError extends Schema.TaggedError<CommandPolicyCapabilityUnsupportedError>()(
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

export const CommandPolicyV2Error = Schema.Union([CommandPolicyCapabilityUnsupportedError]);
export type CommandPolicyV2Error = typeof CommandPolicyV2Error.Type;

type MessageDispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

export function isNativeMaintenanceCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
}): boolean {
  return (
    message.attachments.length === 0 &&
    ["/compact", "/logout"].includes(message.text.trim().toLowerCase())
  );
}

/**
 * A goal command sent into active work stops that work when it starts or
 * replaces goal work, or ends a goal that is driving the run.
 */
export function goalCommandStopsActiveRun(
  command: OrchestrationV2GoalCommand,
  goalStatus: OrchestrationV2ProviderGoalStatus | null,
): boolean {
  switch (command.type) {
    case "set":
    case "resume":
      return true;
    case "clear":
    case "pause":
      return goalStatus === "active";
    case "show":
      return false;
  }
}

export function resolveMessageDispatchIntent(
  projection: OrchestrationV2ThreadProjection,
  requestedMode: MessageDispatchMode,
  deliveryIntent?: "auto" | "steer" | "restart",
): MessageDispatchMode {
  const mode = resolveDeliveryIntent(projection, requestedMode, deliveryIntent);
  if (mode.type !== "steer_active") return mode;
  // Compaction and sign-out cannot accept steers; queue follow-ups.
  const target = projection.runs.find((run) => run.id === mode.targetRunId);
  const targetMessage = projection.messages.find((message) => message.id === target?.userMessageId);
  if (targetMessage !== undefined && isNativeMaintenanceCommand(targetMessage)) {
    return { type: "queue_after_active" };
  }
  // A provider that can neither steer nor restart its turn takes the message after the turn.
  const turns =
    target === undefined || !isActiveRun(target)
      ? undefined
      : providerTurnCapabilities(projection, target);
  return turns !== undefined &&
    !turns.supportsActiveSteering &&
    !(turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart) &&
    turns.supportsQueuedMessages
    ? { type: "queue_after_active" }
    : mode;
}

/** A run that still owns the thread's provider turn. */
export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

function providerTurnCapabilities(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
) {
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const providerSession =
    providerThread?.providerSessionId == null
      ? undefined
      : projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        );
  return providerSession?.capabilities.turns;
}

function resolveDeliveryIntent(
  projection: OrchestrationV2ThreadProjection,
  requestedMode: MessageDispatchMode,
  deliveryIntent?: "auto" | "steer" | "restart",
): MessageDispatchMode {
  if (deliveryIntent === undefined) return requestedMode;

  const activeRun = projection.runs.findLast(isActiveRun);
  if (activeRun === undefined) return { type: "start_immediately" };
  if (deliveryIntent === "steer") {
    return { type: "steer_active", targetRunId: activeRun.id };
  }
  if (deliveryIntent === "restart") {
    return { type: "restart_active", targetRunId: activeRun.id };
  }
  // A run can be active before its provider turn starts or after it finishes.
  // Queue automatic input in those gaps so steering cannot reject the message.
  if (
    activeRun.status === "preparing" ||
    activeRun.status === "starting" ||
    !projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    )
  ) {
    return { type: "queue_after_active" };
  }

  const capabilities = providerTurnCapabilities(projection, activeRun);
  if (capabilities?.supportsActiveSteering === true) {
    return { type: "steer_active", targetRunId: activeRun.id };
  }
  if (capabilities?.supportsQueuedMessages === true) {
    return { type: "queue_after_active" };
  }
  if (capabilities?.supportsSteeringByInterruptRestart === true) {
    return { type: "restart_active", targetRunId: activeRun.id };
  }
  return { type: "queue_after_active" };
}

interface CapabilityCheckInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}

export interface CommandPolicyV2Shape {
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
      readonly sourceRunStatus: OrchestrationV2Run["status"];
      readonly fromSpecificTurn: boolean;
      /** Later source runs are still active; providers cannot fork a thread mid-turn. */
      readonly sourceBusy: boolean;
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
      input.forceRestart || input.capabilities.turns.supportsInterrupt
        ? "interrupt_restart_steering"
        : "active_steering",
      input.forceRestart
        ? "providerInstanceId cannot satisfy a required interrupt-and-restart"
        : "providerInstanceId cannot steer active turns directly or by interrupt-and-restart",
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
  // Unsuccessful runs may lack native cursors; fork bounded transcripts to exclude later turns.
  const canForkNatively =
    (input.sourceRunStatus === "completed" || input.sourceRunStatus === "waiting") &&
    input.sameProvider &&
    input.hasStrongNativeSource &&
    !input.sourceBusy &&
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

export const layer: Layer.Layer<CommandPolicyV2> = Layer.succeed(CommandPolicyV2, {
  ensureQueuedMessages,
  decideSteeringExecution,
  ensureInterrupt,
  ensureNativeFork,
  decideForkExecution,
  ensureRollback,
  ensureContextHandoff,
});

import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

type CommandType = ClientOrchestrationCommand["type"];
type CommandOf<T extends CommandType> = Extract<ClientOrchestrationCommand, { readonly type: T }>;
type CommandInput<T extends CommandType> = Omit<
  CommandOf<T>,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CommandOf<T>
    ? {
        readonly createdAt?: CommandOf<T>["createdAt"];
      }
    : {});

export type CreateProjectInput = CommandInput<"project.create">;
export type UpdateProjectInput = CommandInput<"project.meta.update">;
export type DeleteProjectInput = CommandInput<"project.delete">;
export type CreateThreadInput = CommandInput<"thread.create">;
export type DeleteThreadInput = CommandInput<"thread.delete">;
export type ArchiveThreadInput = CommandInput<"thread.archive">;
export type UnarchiveThreadInput = CommandInput<"thread.unarchive">;
export type SettleThreadInput = CommandInput<"thread.settle">;
export type UnsettleThreadInput = CommandInput<"thread.unsettle">;
export type SnoozeThreadInput = CommandInput<"thread.snooze">;
export type UnsnoozeThreadInput = CommandInput<"thread.unsnooze">;
export type PinThreadInput = CommandInput<"thread.pin">;
export type UnpinThreadInput = CommandInput<"thread.unpin">;
export type ReorderPinnedThreadInput = CommandInput<"thread.pin.reorder">;
export type ReorderActiveThreadInput = CommandInput<"thread.active.reorder">;
export type UpdateThreadMetadataInput = CommandInput<"thread.meta.update">;
export type LinkThreadPullRequestInput = CommandInput<"thread.pull-request.link">;
export type UnlinkThreadPullRequestInput = CommandInput<"thread.pull-request.unlink">;
export type SetThreadRuntimeModeInput = CommandInput<"thread.runtime-mode.set">;
export type SetThreadInteractionModeInput = CommandInput<"thread.interaction-mode.set">;
export type StartThreadTurnInput = CommandInput<"thread.turn.start">;
export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;
export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;
export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;
export type DismissThreadUserInputInput = CommandInput<"thread.user-input.dismiss">;
export type RevertThreadCheckpointInput = CommandInput<"thread.checkpoint.revert"> & {
  readonly restoreFiles?: boolean;
};
export type StopThreadSessionInput = CommandInput<"thread.session.stop">;

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function commandId(input: { readonly commandId?: CommandId }) {
  return Effect.gen(function* () {
    if (input.commandId !== undefined) {
      return input.commandId;
    }
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
  });
}

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: commandId(input),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

export const createProject: (input: CreateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createProject",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "project.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const updateProject: (input: UpdateProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.meta.update",
    commandId: yield* commandId(input),
  });
});

export const deleteProject: (input: DeleteProjectInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteProject",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "project.delete",
    commandId: yield* commandId(input),
  });
});

export const createThread: (input: CreateThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createThread",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.create",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const deleteThread: (input: DeleteThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.delete",
    commandId: yield* commandId(input),
  });
});

export const archiveThread: (input: ArchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.archive",
    commandId: yield* commandId(input),
  });
});

export const unarchiveThread: (input: UnarchiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unarchive",
    commandId: yield* commandId(input),
  });
});

export const settleThread: (input: SettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.settle",
    commandId: yield* commandId(input),
  });
});

export const unsettleThread: (input: UnsettleThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsettle",
    commandId: yield* commandId(input),
  });
});

export const snoozeThread: (input: SnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.snooze",
    commandId: yield* commandId(input),
  });
});

export const unsnoozeThread: (input: UnsnoozeThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unsnooze",
    commandId: yield* commandId(input),
  });
});

export const pinThread: (input: PinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin",
    commandId: yield* commandId(input),
  });
});

export const unpinThread: (input: UnpinThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.unpin",
    commandId: yield* commandId(input),
  });
});

export const reorderPinnedThread: (input: ReorderPinnedThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export const reorderActiveThread: (input: ReorderActiveThreadInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderActiveThread",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.active.reorder",
    commandId: yield* commandId(input),
  });
});

export const updateThreadMetadata: (input: UpdateThreadMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateThreadMetadata",
)(function* (input) {
  return yield* dispatch({
    ...input,
    type: "thread.meta.update",
    commandId: yield* commandId(input),
  });
});

export const linkThreadPullRequest: (input: LinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.linkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.link",
      commandId: yield* commandId(input),
    });
  });

export const unlinkThreadPullRequest: (input: UnlinkThreadPullRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.unlinkThreadPullRequest")(function* (input) {
    return yield* dispatch({
      ...input,
      type: "thread.pull-request.unlink",
      commandId: yield* commandId(input),
    });
  });

export const setThreadRuntimeMode: (input: SetThreadRuntimeModeInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadRuntimeMode",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.runtime-mode.set",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const setThreadInteractionMode: (input: SetThreadInteractionModeInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.setThreadInteractionMode")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.interaction-mode.set",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const dismissThreadUserInput: (input: DismissThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.dismissThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.user-input.dismiss",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const revertThreadCheckpoint: (input: RevertThreadCheckpointInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    const { restoreFiles, ...command } = input;
    return yield* dispatch({
      ...command,
      type: restoreFiles === false ? "thread.conversation.revert" : "thread.checkpoint.revert",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

/** Fail closed against the connected server's capability, including after a downgrade. */
const requireTasks = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  const supported =
    Option.isSome(session) &&
    (yield* session.value.initialConfig.pipe(
      Effect.map((config) => config.environment.capabilities.tasks === true),
      Effect.orElseSucceed(() => false),
    ));
  if (!supported) {
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: "Tasks are not supported by this environment.",
    });
  }
});

export type CreateTaskInput = CommandInput<"task.create">;
export const createTask: (input: CreateTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.createTask",
)(function* (input) {
  yield* requireTasks;
  const metadata = yield* timestampedCommandMetadata(input);
  return yield* dispatch({ ...input, type: "task.create", ...metadata });
});

export type UpdateTaskMetadataInput = CommandInput<"task.meta.update">;
export const updateTaskMetadata: (input: UpdateTaskMetadataInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.updateTaskMetadata",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({
    ...input,
    type: "task.meta.update",
    commandId: yield* commandId(input),
  });
});

export type DeleteTaskInput = CommandInput<"task.delete">;
export const deleteTask: (input: DeleteTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.deleteTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.delete", commandId: yield* commandId(input) });
});

export type ArchiveTaskInput = CommandInput<"task.archive">;
export const archiveTask: (input: ArchiveTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.archiveTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.archive", commandId: yield* commandId(input) });
});

export type UnarchiveTaskInput = CommandInput<"task.unarchive">;
export const unarchiveTask: (input: UnarchiveTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unarchiveTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.unarchive", commandId: yield* commandId(input) });
});

export type SettleTaskInput = CommandInput<"task.settle">;
export const settleTask: (input: SettleTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.settleTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.settle", commandId: yield* commandId(input) });
});

export type UnsettleTaskInput = CommandInput<"task.unsettle">;
export const unsettleTask: (input: UnsettleTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsettleTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.unsettle", commandId: yield* commandId(input) });
});

export type SnoozeTaskInput = CommandInput<"task.snooze">;
export const snoozeTask: (input: SnoozeTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.snoozeTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.snooze", commandId: yield* commandId(input) });
});

export type UnsnoozeTaskInput = CommandInput<"task.unsnooze">;
export const unsnoozeTask: (input: UnsnoozeTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unsnoozeTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.unsnooze", commandId: yield* commandId(input) });
});

export type PinTaskInput = CommandInput<"task.pin">;
export const pinTask: (input: PinTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.pinTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.pin", commandId: yield* commandId(input) });
});

export type UnpinTaskInput = CommandInput<"task.unpin">;
export const unpinTask: (input: UnpinTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.unpinTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "task.unpin", commandId: yield* commandId(input) });
});

export type ReorderPinnedTaskInput = CommandInput<"task.pin.reorder">;
export const reorderPinnedTask: (input: ReorderPinnedTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderPinnedTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({
    ...input,
    type: "task.pin.reorder",
    commandId: yield* commandId(input),
  });
});

export type ReorderActiveTaskInput = CommandInput<"task.active.reorder">;
export const reorderActiveTask: (input: ReorderActiveTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.reorderActiveTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({
    ...input,
    type: "task.active.reorder",
    commandId: yield* commandId(input),
  });
});

export type SetThreadTaskInput = CommandInput<"thread.task.set">;
export const setThreadTask: (input: SetThreadTaskInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.setThreadTask",
)(function* (input) {
  yield* requireTasks;
  return yield* dispatch({ ...input, type: "thread.task.set", commandId: yield* commandId(input) });
});

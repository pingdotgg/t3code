import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type CreateTaskInput,
  createTask,
  type UpdateTaskMetadataInput,
  updateTaskMetadata,
  type DeleteTaskInput,
  deleteTask,
  type ArchiveTaskInput,
  archiveTask,
  type UnarchiveTaskInput,
  unarchiveTask,
  type SettleTaskInput,
  settleTask,
  type UnsettleTaskInput,
  unsettleTask,
  type SnoozeTaskInput,
  snoozeTask,
  type UnsnoozeTaskInput,
  unsnoozeTask,
  type PinTaskInput,
  pinTask,
  type UnpinTaskInput,
  unpinTask,
  type ReorderPinnedTaskInput,
  reorderPinnedTask,
  type ReorderActiveTaskInput,
  reorderActiveTask,
} from "../operations/commands.ts";
export type {
  CreateTaskInput,
  UpdateTaskMetadataInput,
  DeleteTaskInput,
  ArchiveTaskInput,
  UnarchiveTaskInput,
  SettleTaskInput,
  UnsettleTaskInput,
  SnoozeTaskInput,
  UnsnoozeTaskInput,
  PinTaskInput,
  UnpinTaskInput,
  ReorderPinnedTaskInput,
  ReorderActiveTaskInput,
} from "../operations/commands.ts";

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { taskId: string } }) =>
      JSON.stringify([environmentId, input.taskId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.create",
      execute: (input: CreateTaskInput) => createTask(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.meta.update",
      execute: (input: UpdateTaskMetadataInput) => updateTaskMetadata(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.delete",
      execute: (input: DeleteTaskInput) => deleteTask(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.archive",
      execute: (input: ArchiveTaskInput) => archiveTask(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.unarchive",
      execute: (input: UnarchiveTaskInput) => unarchiveTask(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.settle",
      execute: (input: SettleTaskInput) => settleTask(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.unsettle",
      execute: (input: UnsettleTaskInput) => unsettleTask(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.snooze",
      execute: (input: SnoozeTaskInput) => snoozeTask(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.unsnooze",
      execute: (input: UnsnoozeTaskInput) => unsnoozeTask(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.pin",
      execute: (input: PinTaskInput) => pinTask(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.unpin",
      execute: (input: UnpinTaskInput) => unpinTask(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.pin.reorder",
      execute: (input: ReorderPinnedTaskInput) => reorderPinnedTask(input),
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task.active.reorder",
      execute: (input: ReorderActiveTaskInput) => reorderActiveTask(input),
      scheduler,
      concurrency,
    }),
  };
}

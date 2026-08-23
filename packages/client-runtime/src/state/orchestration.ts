import {
  type EnvironmentAuthorizationError,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationDispatchCommandError,
  type EnvironmentId,
} from "@t3tools/contracts";
import { RpcClientError } from "effect/unstable/rpc";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  cancelTask,
  scheduleTask,
  type CancelTaskInput,
  type ScheduleTaskInput,
} from "../operations/commands.ts";
import type { EnvironmentRpcSuccess, EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { EnvironmentNotRegisteredError } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
  type AtomCommand,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;

type DispatchFailure =
  | EnvironmentAuthorizationError
  | EnvironmentNotRegisteredError
  | EnvironmentRpcUnavailableError
  | OrchestrationDispatchCommandError
  | RpcClientError.RpcClientError;

/** Explicit shape so consumers can name the type without reaching into
    internal module paths (TS portability of inferred declarations). */
export interface TaskEnvironmentCommands<E> {
  readonly scheduleTask: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: ScheduleTaskInput },
    EnvironmentRpcSuccess<DispatchTag>,
    DispatchFailure | E
  >;
  readonly cancelTask: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: CancelTaskInput },
    EnvironmentRpcSuccess<DispatchTag>,
    DispatchFailure | E
  >;
}

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    scheduledTasks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:scheduled-tasks",
      tag: ORCHESTRATION_WS_METHODS.listTasks,
      // Task state changes are rare (schedule/cancel/fire); a short stale
      // window plus a modest refresh keeps an open panel current without
      // hammering the server.
      staleTimeMs: 15_000,
      idleTtlMs: 60_000,
      refreshIntervalMs: 30_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
  };
}

export function createTaskEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
): TaskEnvironmentCommands<E> {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { taskId?: string } }) =>
      JSON.stringify([environmentId, input.taskId ?? null]),
  };
  return {
    scheduleTask: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:schedule",
      execute: (input: ScheduleTaskInput) => scheduleTask(input),
      scheduler,
      concurrency,
    }),
    cancelTask: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:task:cancel",
      execute: (input: CancelTaskInput) => cancelTask(input),
      scheduler,
      concurrency,
    }),
  };
}

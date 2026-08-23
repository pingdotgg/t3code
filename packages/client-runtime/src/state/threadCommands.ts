import {
  type CodexGoal,
  type CodexGoalSetInput,
  type CodexGoalStatus,
  type CodexGoalStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type CodexGoalCommand =
  | { readonly action: "status" }
  | { readonly action: "set"; readonly objective?: string; readonly status?: "active" | "paused" }
  | { readonly action: "clear" }
  | { readonly action: "invalid"; readonly message: string };

const GOAL_USAGE =
  "Usage: /goal [status | create <objective> | steer <objective> | pause | resume | clear | reset]";

export function toCodexGoalSubscriptionTarget<
  EnvironmentId,
  GoalInput extends { readonly threadId: unknown },
>(target: {
  readonly environmentId: EnvironmentId;
  readonly input: GoalInput;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: GoalInput["threadId"] };
} {
  return {
    environmentId: target.environmentId,
    input: { threadId: target.input.threadId },
  };
}

export function formatCodexGoalUsage(goal: CodexGoal): string {
  const budget = goal.tokenBudget == null ? "" : ` / ${goal.tokenBudget.toLocaleString()}`;
  return `${goal.tokensUsed.toLocaleString()} tokens${budget}, ${goal.timeUsedSeconds.toLocaleString()} seconds`;
}

export function formatCodexGoalDescription(goal: CodexGoal): string {
  return `${goal.objective} - ${formatCodexGoalUsage(goal)}`;
}

const CODEX_GOAL_STATUS_LABELS: Record<CodexGoalStatus, string> = {
  active: "active",
  paused: "paused",
  budgetLimited: "budget limited",
  usageLimited: "usage limited",
  complete: "complete",
  blocked: "blocked",
};

export function formatCodexGoalStatus(status: CodexGoalStatus): string {
  return CODEX_GOAL_STATUS_LABELS[status];
}

export function formatCodexGoalError(error: unknown): string {
  if (!(error instanceof Error)) return "Codex Goal operation failed.";
  const reason = error.cause instanceof Error ? error.cause.message.trim() : "";
  return reason.length === 0 ? error.message : `${error.message}: ${reason}`;
}

export function parseCodexGoalCommand(value: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(value.trim());
  if (match === null) return null;

  const argument = match[1]?.trim() ?? "";
  if (argument === "" || argument.toLowerCase() === "status") return { action: "status" };

  const [rawAction = "", ...rest] = argument.split(/\s+/);
  const action = rawAction.toLowerCase();
  const objective = rest.join(" ").trim();
  if (action === "create" || action === "steer") {
    if (objective === "") return { action: "invalid", message: GOAL_USAGE };
    return action === "create"
      ? { action: "set", objective, status: "active" }
      : { action: "set", objective };
  }
  if (action === "edit") {
    return objective === ""
      ? {
          action: "invalid",
          message: "T3 does not open Codex's Goal editor. Use /goal steer <objective>.",
        }
      : { action: "set", objective };
  }
  if (action === "pause" || action === "resume") {
    if (objective !== "") return { action: "invalid", message: GOAL_USAGE };
    return { action: "set", status: action === "pause" ? "paused" : "active" };
  }
  if (action === "clear" || action === "reset") {
    if (objective !== "") return { action: "invalid", message: GOAL_USAGE };
    return { action: "clear" };
  }
  if (action === "status") return { action: "invalid", message: GOAL_USAGE };

  // Match Codex's `/goal <objective>` shorthand.
  return { action: "set", objective: argument, status: "active" };
}

interface CodexGoalProjection {
  readonly goal: CodexGoal | null;
  readonly hasNativeUpdate: boolean;
}

export function applyCodexGoalStreamEvent(
  current: CodexGoalProjection,
  event: CodexGoalStreamEvent,
): CodexGoalProjection {
  if (event.type === "snapshot") {
    return current.hasNativeUpdate ? current : { goal: event.goal, hasNativeUpdate: false };
  }
  if (event.type === "updated") return { goal: event.goal, hasNativeUpdate: true };
  return { goal: null, hasNativeUpdate: true };
}

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const codexGoal = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:codex-goal",
    tag: WS_METHODS.subscribeCodexGoal,
    transform: (events) =>
      events.pipe(
        Stream.mapAccum(
          (): CodexGoalProjection => ({ goal: null, hasNativeUpdate: false }),
          (current, event) => {
            const next = applyCodexGoalStreamEvent(current, event);
            return [next, [next.goal]] as const;
          },
        ),
      ),
  });
  const refreshCodexGoal = (
    target: Parameters<typeof codexGoal>[0],
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(codexGoal(target)));

  return {
    codexGoal,
    getCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:get",
      tag: WS_METHODS.codexGoalGet,
      scheduler,
      concurrency,
      onSuccess: refreshCodexGoal,
    }),
    setCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:set",
      tag: WS_METHODS.codexGoalSet,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }: { environmentId: string; input: CodexGoalSetInput }) =>
          JSON.stringify([environmentId, input.threadId]),
      },
      onSuccess: (target, registry) =>
        refreshCodexGoal(toCodexGoalSubscriptionTarget(target), registry),
    }),
    clearCodexGoal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:codex-goal:clear",
      tag: WS_METHODS.codexGoalClear,
      scheduler,
      concurrency,
      onSuccess: refreshCodexGoal,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
}

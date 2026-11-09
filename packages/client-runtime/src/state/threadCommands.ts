import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import {
  WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";
import * as DateTime from "effect/DateTime";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type InterruptThreadTurnInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  closeGuestShare,
  resolveGuestMessage,
  cancelQueuedRun,
  createThread,
  deleteThread,
  editQueuedRun,
  interruptThreadTurn,
  forkSideChat,
  forkThreadFromRun,
  markThreadUnread,
  mergeThreadBack,
  promoteQueuedRun,
  resumeThreadQueue,
  retryWorkspacePreparation,
  linkThreadPullRequest,
  respondToThreadApproval,
  respondToThreadUserInput,
  dismissThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  reorderActiveThread,
  setThreadAutoSettle,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unlinkThreadPullRequest,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
  visitThread,
  watchThreadPullRequest,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

export type LoadEarlierThreadHistoryInput = {
  readonly threadId: ThreadId;
  readonly throughEntryId?: string;
  readonly workAnchorId?: string;
};

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const loadEarlierHistory = Effect.fn("ThreadCommands.loadEarlierHistory")(function* (
    input: LoadEarlierThreadHistoryInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    if (Option.isNone(controller)) {
      return {
        _tag: "noop",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    return yield* controller.value.loadEarlier(
      supervisor.target.environmentId,
      input.threadId,
      input.throughEntryId,
      input.workAnchorId,
    );
  });

  // Runs whether or not the server accepted the interrupt, so a stale cached item still
  // settles when Stop had nothing to interrupt; the interrupt's own failure still surfaces.
  // The repair is detached: its lookups must not hold the thread's serial command key, and
  // closing the thread cancels the repair, not the Stop that triggered it.
  const interruptTurn = Effect.fn("ThreadCommands.interruptTurn")(function* (
    input: InterruptThreadTurnInput,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const controller = yield* Effect.serviceOption(ThreadHistoryController.ThreadHistoryController);
    return yield* interruptThreadTurn(input).pipe(
      Effect.ensuring(
        Option.match(controller, {
          onNone: () => Effect.void,
          onSome: (value) =>
            value
              .reconcilePendingWork(supervisor.target.environmentId, input.threadId)
              .pipe(Effect.forkDetach, Effect.asVoid),
        }),
      ),
    );
  });

  const commands = {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: createThread,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: deleteThread,
      scheduler,
      concurrency,
    }),
    closeGuestShare: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:close-guest-share",
      execute: closeGuestShare,
      scheduler,
      concurrency,
    }),
    resolveGuestMessage: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resolve-guest-message",
      execute: resolveGuestMessage,
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: archiveThread,
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: unarchiveThread,
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: settleThread,
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: unsettleThread,
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: snoozeThread,
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: unsnoozeThread,
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: pinThread,
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: unpinThread,
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: reorderPinnedThread,
      scheduler,
      concurrency,
    }),
    setAutoSettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-auto-settle",
      execute: setThreadAutoSettle,
      scheduler,
      concurrency,
    }),
    reorderActive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-active",
      execute: reorderActiveThread,
      scheduler,
      concurrency,
    }),
    visit: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:visit",
      execute: visitThread,
      scheduler,
      // Visits repeat constantly and only the newest matters. On the serial lane a slow
      // one held every settle, pin, or stop on the thread behind it with no feedback.
      // An open counts toward search frecency, so a plain revisit never replaces one.
      concurrency: {
        mode: "latest",
        key: ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: Parameters<typeof visitThread>[0];
        }) =>
          JSON.stringify([
            environmentId,
            input.threadId,
            input.opened === true ? (input.searchQuery ?? "") : null,
          ]),
      },
    }),
    markUnread: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:mark-unread",
      execute: markThreadUnread,
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: updateThreadMetadata,
      scheduler,
      concurrency,
    }),
    linkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:link-pull-request",
      execute: linkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    unlinkPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unlink-pull-request",
      execute: unlinkThreadPullRequest,
      scheduler,
      concurrency,
    }),
    watchPullRequest: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:watch-pull-request",
      execute: watchThreadPullRequest,
      scheduler,
      concurrency,
    }),
    setModelSelection: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-model-selection",
      execute: (input: UpdateThreadMetadataInput & { readonly modelSelection: ModelSelection }) =>
        updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: setThreadRuntimeMode,
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: setThreadInteractionMode,
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: startThreadTurn,
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: interruptTurn,
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: respondToThreadApproval,
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: respondToThreadUserInput,
      scheduler,
      concurrency,
    }),
    dismissUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:dismiss-user-input",
      execute: dismissThreadUserInput,
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: revertThreadCheckpoint,
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: stopThreadSession,
      scheduler,
      concurrency,
    }),
    forkFromRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-from-run",
      execute: forkThreadFromRun,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    forkSideChat: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:fork-side-chat",
      execute: forkSideChat,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.sourceThreadId]),
      },
    }),
    mergeBack: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:merge-back",
      execute: mergeThreadBack,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceThreadId, input.targetThreadId]),
      },
    }),
    resumeThreadQueue: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:resume-queue",
      execute: resumeThreadQueue,
      scheduler,
      concurrency,
    }),
    promoteQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:promote-queued-run",
      execute: promoteQueuedRun,
      scheduler,
      concurrency,
    }),
    cancelQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-queued-run",
      execute: cancelQueuedRun,
      scheduler,
      concurrency,
    }),
    retryWorkspacePreparation: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:retry-workspace-preparation",
      execute: retryWorkspacePreparation,
      scheduler,
      concurrency,
    }),
    editQueuedRun: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:edit-queued-run",
      execute: editQueuedRun,
      scheduler,
      concurrency,
    }),
    loadEarlierHistory: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:load-earlier-history",
      execute: loadEarlierHistory,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          `history:${JSON.stringify([environmentId, input.threadId])}`,
      },
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
  const optimistic = createOptimisticThreadLifecycle(snapshotAtom);
  const busy = (thread: OrchestrationV2ThreadShell) =>
    thread.pendingRuntimeRequest !== null ||
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status);
  const settled = (thread: OrchestrationV2ThreadShell, now: DateTime.Utc) => ({
    ...thread,
    pendingRuntimeRequest: null,
    settledOverride: "settled" as const,
    settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
    unsettledAt: null,
    activeOrderKey: null,
    pinnedAt: null,
    pinOrderKey: null,
    snoozedAt: null,
    snoozedUntil: null,
  });
  /**
   * The sub-runs a settle cascades to on the server (SettlementCascade): idle unsettled ones
   * settle with it, ones settled on their own pass the cascade through, and a busy one stays
   * active with everything under it until its run ends.
   */
  const settleFollowers = (snapshot: OrchestrationV2ShellSnapshot, threadId: ThreadId) => {
    const children = new Map<ThreadId, Array<OrchestrationV2ThreadShell>>();
    for (const thread of snapshot.threads) {
      if (thread.parentThreadId == null || thread.parentEnvironmentId != null) continue;
      const siblings = children.get(thread.parentThreadId) ?? [];
      siblings.push(thread);
      children.set(thread.parentThreadId, siblings);
    }
    const followers: Array<ThreadId> = [];
    const visited = new Set([threadId]);
    const pending = [threadId];
    while (pending.length > 0) {
      for (const child of children.get(pending.pop()!) ?? []) {
        if (visited.has(child.id) || busy(child)) continue;
        visited.add(child.id);
        if (child.settledOverride !== "settled") followers.push(child.id);
        pending.push(child.id);
      }
    }
    return followers;
  };
  return {
    ...commands,
    snapshotAtom: optimistic.snapshotAtom,
    pendingThreadIdsAtom: optimistic.pendingThreadIdsAtom,
    settle: optimistic.wrap(
      commands.settle,
      (thread, _input, now, accepted) =>
        !accepted && busy(thread) ? thread : settled(thread, now),
      {
        select: (snapshot, input) => settleFollowers(snapshot, input.threadId),
        apply: settled,
        // The child's own settle event landed, or it changed in a way the cascade leaves alone.
        landed: (thread, now) =>
          thread.settledOverride === "settled" ||
          busy(thread) ||
          DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(now),
      },
    ),
    unsettle: optimistic.wrap(commands.unsettle, (thread, input, now) => ({
      ...thread,
      settledOverride: input.reason === "user" ? "active" : null,
      settledAt: null,
      unsettledAt: thread.settledOverride === "active" ? (thread.unsettledAt ?? null) : now,
    })),
    snooze: optimistic.wrap(commands.snooze, (thread, input, now, accepted) =>
      (!accepted &&
        ((thread.pendingRuntimeRequest !== null &&
          thread.pendingRuntimeRequest.kind !== "user_input") ||
          ["preparing", "queued", "starting"].includes(thread.status))) ||
      !(Date.parse(input.snoozedUntil) > DateTime.toEpochMillis(now))
        ? thread
        : {
            ...thread,
            snoozedUntil: DateTime.makeUnsafe(input.snoozedUntil),
            snoozedAt: now,
          },
    ),
    unsnooze: optimistic.wrap(commands.unsnooze, (thread) => ({
      ...thread,
      snoozedUntil: null,
      snoozedAt: null,
    })),
    setAutoSettle: optimistic.wrap(commands.setAutoSettle, (thread, input, now) => ({
      ...thread,
      autoSettleDisabledAt: input.enabled ? null : (thread.autoSettleDisabledAt ?? now),
    })),
    pin: optimistic.wrap(commands.pin, (thread, input, now) => ({
      ...thread,
      pinnedAt: thread.pinnedAt ?? now,
      pinOrderKey: thread.pinnedAt == null ? (input.orderKey ?? null) : thread.pinOrderKey,
      ...(thread.settledOverride === "settled"
        ? {
            settledOverride: "active" as const,
            settledAt: null,
            unsettledAt: now,
          }
        : {}),
      snoozedUntil: null,
      snoozedAt: null,
    })),
    unpin: optimistic.wrap(commands.unpin, (thread) => ({
      ...thread,
      pinnedAt: null,
      pinOrderKey: null,
    })),
    reorderPin: optimistic.wrap(commands.reorderPin, (thread, input) => ({
      ...thread,
      pinOrderKey: input.orderKey,
    })),
    reorderActive: optimistic.wrap(commands.reorderActive, (thread, input) => ({
      ...thread,
      activeOrderKey: input.orderKey,
    })),
    // Shown at once, so a composer that releases its accepted pick keeps showing it.
    setModelSelection: optimistic.wrap(commands.setModelSelection, (thread, input) => ({
      ...thread,
      modelSelection: input.modelSelection,
    })),
  };
}

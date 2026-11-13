/**
 * Pi turn finalization, settle probes, settle-time tree capture and prompt cancellation.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import {
  piSessionListing,
  walkPiBranch,
} from "./projection.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";
import type { Usage } from "./usage.ts";

export const makeTurns = (deps: State & Emitters & Usage) => {
  const {
    connection,
    now,
    events,
    scope,
    request,
    pendingPrompts,
    sessionEventPermit,
  } = deps;
  const m = deps.mutable;
  const listSessionEntries = (since: string | null, timeoutMs: number) =>
    request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
      Effect.map(piSessionListing),
      Effect.orElseSucceed(() => null),
    );

  const captureTurnTreeRefs = Effect.fnUntraced(function* (
    timeoutMs = PI_REQUEST_TIMEOUT_MS,
  ): Effect.fn.Return<PiTurnTreeRefs | null> {
    const cursorWasStale = m.leafCursorStale;
    const previousLeaf = m.lastKnownLeaf;
    const fullListing = cursorWasStale || previousLeaf === null;
    const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
    const turnWalk =
      listing === null ? null : walkPiBranch(listing.entries, listing.leafId, previousLeaf);
    const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
    // since ends at the previous leaf; rewound ancestry requires the whole tree.
    const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
    if (listing === null || turnWalk === null || tree === null) {
      m.leafCursorStale = true;
      return null;
    }
    m.lastKnownLeaf = listing.leafId;
    m.leafCursorStale = false;
    const turnStartEntryId = turnWalk.userEntryIds.at(-1);
    // Only a complete acyclic root walk proves all survivors.
    // The old leaf must remain in this tree to prove rewind rather than session replacement.
    const branch =
      rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
        ? walkPiBranch(tree.entries, listing.leafId, null)
        : undefined;
    return {
      // Stale cursors span earlier turns; keep a synthetic ref to avoid rolling back too far.
      nativeTurnRef: cursorWasStale
        ? undefined
        : turnStartEntryId !== undefined
          ? providerRef(turnStartEntryId)
          : turnWalk.entryCount === 0
            ? null
            : undefined,
      leafId: listing.leafId,
      retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
    };
  });

  const finalizeTurn = Effect.fnUntraced(function* (state: PiThreadState, readUsage = true) {
    const turn = state.activeTurn;
    if (turn === null) return;
    state.activeTurn = null;
    const interrupted = turn.interrupted || turn.nativeAborted;
    const completedAt = yield* DateTime.now;
    yield* deps.completeOpenStreamItems(turn);
    if (turn.activeCompaction !== null) {
      const status = interrupted ? "cancelled" : turn.failure === null ? "completed" : "failed";
      yield* deps.emitCompaction(turn, turn.activeCompaction, status);
      turn.activeCompaction = null;
    }
    if (turn.activeProviderRetry !== null) {
      if (interrupted) {
        yield* deps.emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
        turn.activeProviderRetry = null;
      } else if (turn.failure === null) {
        yield* deps.emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
        turn.activeProviderRetry = null;
      }
    }
    yield* cancelPendingPrompts(completedAt);
    const treeRefs =
      turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
    const tokenUsage = readUsage
      ? yield* deps.readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
      : undefined;
    const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
    yield* deps.emit({
      type: "provider_turn.updated",
      driver: PI_PROVIDER,
      threadId: turn.turnInput.threadId,
      providerTurn: {
        ...turn.providerTurn,
        ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
          ? {}
          : { nativeTurnRef: treeRefs.nativeTurnRef }),
        status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
        completedAt,
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
      },
    });
    yield* deps.updateProviderThread(
      state,
      {
        status: "idle",
        ...(treeRefs === null
          ? {}
          : {
              nativeConversationHeadRef:
                treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
            }),
      },
      treeRefs?.retainedNativeTurnIds,
    );
    yield* deps.updateProviderSession(
      failure !== null ? "error" : "ready",
      failure?.message ?? null,
    );
    if (failure !== null) {
      const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
      if (turn.activeProviderRetry !== null) {
        yield* deps.emitProviderRetry(
          turn,
          { ...turn.activeProviderRetry, failure },
          "failed",
          completedAt,
        );
      } else {
        yield* deps.emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...deps.baseItemFields(turn, failureItemId, completedAt, completedAt),
            status: "failed",
            title: null,
            completedAt,
            type: "error",
            failure,
          },
        });
      }
      yield* deps.emit({
        type: "turn.terminal",
        driver: PI_PROVIDER,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.turnInput.runOrdinal,
        failureItemOrdinal: deps.itemOrdinal(turn, failureItemId),
        status: "failed",
        failure,
        ...(turn.activeProviderRetry === null
          ? {}
          : {
              retry: turn.activeProviderRetry.retry,
              retryStartedAt: turn.activeProviderRetry.startedAt,
            }),
        threadDisposition: "reusable",
      });
    } else {
      yield* deps.emit({
        type: "turn.terminal",
        driver: PI_PROVIDER,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.turnInput.runOrdinal,
        status: interrupted ? "interrupted" : "completed",
        failure: null,
        threadDisposition: "reusable",
      });
    }
  });

  const scheduleSettleProbe = (
    turn: ActivePiTurn,
    settleAfterAgentActivity = false,
    attempt = 1,
  ) => {
    const providerTurnId = turn.providerTurn.id;
    const settleProbeGeneration = turn.settleProbeGeneration;
    return request({ type: "get_state" }, 2_000).pipe(
      Effect.matchEffect({
        onSuccess: (data) =>
          Queue.offer(connection.events, {
            type: "t3.settle_probe",
            providerTurnId,
            settleAfterAgentActivity,
            settleProbeGeneration,
            attempt,
            data,
          }),
        // Failed probes must reach the pump; command-only turns emit no agent events to settle them.
        onFailure: () =>
          Queue.offer(connection.events, {
            type: "t3.settle_probe",
            providerTurnId,
            settleAfterAgentActivity,
            settleProbeGeneration,
            attempt,
            probeFailed: true,
          }),
      }),
      Effect.ignore,
      Effect.forkIn(scope),
    );
  };

  const stopPendingWake = Effect.fnUntraced(function* (wake: PiWake) {
    if (m.pendingWake !== wake || m.threadState !== wake.state || m.closed) return;
    m.pendingWake = null;
    m.stopRequested = true;
    yield* cancelPendingPrompts(yield* DateTime.now);
    yield* connection.terminate;
  });

  const cancelPrompt = Effect.fn("PiAdapter.cancelPrompt")(function* (
    pending: PendingPiPrompt,
    resolvedAt: DateTime.Utc,
  ) {
    if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
    yield* connection
      .send({
        type: "extension_ui_response",
        id: pending.nativeRequestId,
        cancelled: true,
      })
      .pipe(Effect.ignore);
    pending.runtimeRequest = {
      ...pending.runtimeRequest,
      status: "cancelled",
      resolvedAt,
    };
    yield* deps.emit({
      type: "runtime_request.updated",
      driver: PI_PROVIDER,
      threadId: pending.node.threadId,
      runtimeRequest: pending.runtimeRequest,
    });
    yield* deps.emit({
      type: "node.updated",
      driver: PI_PROVIDER,
      node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
    });
    yield* deps.emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: {
        ...pending.turnItem,
        status: "cancelled",
        completedAt: resolvedAt,
        updatedAt: resolvedAt,
      },
    });
  });

  const cancelPendingPrompts = Effect.fn("PiAdapter.cancelPendingPrompts")(function* (
    resolvedAt: DateTime.Utc,
  ) {
    const pending = Array.from(pendingPrompts.values());
    pendingPrompts.clear();
    yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
      discard: true,
    });
  });

  const clearNativeQueue = Effect.fnUntraced(function* (turn: ActivePiTurn) {
    const cleared = yield* request({ type: "clear_queue" }, 2_000).pipe(
      Effect.map((data) =>
        ["steering", "followUp"].flatMap((key) => {
          const texts = recordField(data, key);
          return Array.isArray(texts)
            ? texts.filter((text): text is string => typeof text === "string")
            : [];
        }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    if (cleared.length === 0) return;
    yield* sessionEventPermit.withPermits(1)(
      m.threadState?.activeTurn === turn
        ? deps.emitSystemNotice(
            turn,
            `queue-cleared:${turn.providerTurn.id}`,
            [
              `Stop cleared ${cleared.length} queued ${cleared.length === 1 ? "message" : "messages"} Pi had not read:`,
              // Image-only messages come back as empty text.
              ...cleared.filter((text) => text.length > 0),
            ]
              .join("\n\n")
              .slice(0, 2_000),
          )
        : Effect.void,
    );
  });

  return { listSessionEntries, captureTurnTreeRefs, finalizeTurn, scheduleSettleProbe, stopPendingWake, cancelPrompt, cancelPendingPrompts, clearNativeQueue };
};

export type Turns = ReturnType<typeof makeTurns>;

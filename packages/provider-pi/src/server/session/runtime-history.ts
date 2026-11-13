/**
 * Pi session history surface: conversation rollback and thread forking.
 */
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
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
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "../mcpInjection.ts";
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
  piForkBoundary,
  piForkEntry,
  piThreadSnapshot,
} from "./projection.ts";
import type {
  PiForkBoundary,
} from "./projection.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";
import type { Usage } from "./usage.ts";
import type { Turns } from "./turns.ts";
import type { Threads } from "./threads.ts";

type PiRuntimeHistory = Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "rollbackThread" | "forkThread">;

export const makeRuntimeHistory = (deps: State & Emitters & Usage & Turns & Threads): PiRuntimeHistory => {
  const {
    options,
    input,
    connection,
    spawner,
    cwd,
    idAllocator,
    resolvedLaunchArgs,
    now,
    events,
    request,
    lifecycleRequest,
    sessionEventPermit,
  } = deps;
  const m = deps.mutable;
  const runtime: PiRuntimeHistory = {
    rollbackThread: Effect.fn("PiAdapter.rollbackThread")(
      function* (rollbackInput) {
        const state = m.threadState;
        if (state === null) {
          return yield* protocolError("Pi session has no registered thread");
        }
        if (state.providerThread.id !== rollbackInput.providerThread.id) {
          return yield* protocolError(
            "Pi rollback requested for a thread this session does not host",
          );
        }
        if (state.activeTurn !== null) {
          return yield* protocolError("Cannot roll back while a Pi turn is active");
        }
        if (m.pendingWake !== null) {
          return yield* protocolError("Cannot roll back while native Pi work awaits a turn");
        }
        const boundary = piForkBoundary(rollbackInput);
        if (boundary.type === "nothing") {
          return piThreadSnapshot(state.providerThread);
        }
        const forkEntryId = yield* piForkEntry(
          boundary,
          rollbackInput.providerThread.createdAt,
          request({ type: "get_entries" }),
        );
        return yield* Effect.acquireUseRelease(
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              if (
                m.rollbackBarrier !== null ||
                m.threadState !== state ||
                state.activeTurn !== null ||
                m.pendingWake !== null ||
                m.closed ||
                m.stopRequested
              )
                return yield* protocolError(
                  "Pi rollback ownership changed before its fork could start",
                );
              const barrier = yield* Deferred.make<
                void,
                ProviderAdapter.ProviderAdapterProtocolError
              >();
              m.rollbackBarrier = barrier;
              return barrier;
            }),
          ),
          (barrier) =>
            Effect.gen(function* () {
              const forkData = yield* lifecycleRequest({ type: "fork", entryId: forkEntryId });
              if (recordField(forkData, "cancelled") === true)
                return yield* protocolError("A Pi extension cancelled the session fork");
              const forkState = yield* request({ type: "get_state" }).pipe(
                Effect.onError(() =>
                  Effect.sync(() => {
                    m.threadState = null;
                  }),
                ),
              );
              const forkSessionFile = recordString(forkState, "sessionFile");
              if (forkSessionFile === undefined) {
                m.threadState = null;
                return yield* protocolError("Pi fork did not return a persisted session file");
              }
              const entriesData = yield* request({ type: "get_entries" }).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              const leafId = recordString(entriesData, "leafId") ?? null;
              // RPC responses bypass the pump; drain prior native events before replacing their binding.
              const queued = yield* Queue.offer(connection.events, {
                type: "t3.rollback_barrier",
                barrier,
              });
              if (!queued) return yield* protocolError("Pi transport closed during rollback");
              yield* Deferred.await(barrier);
              return yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (m.pendingWake !== null) {
                    yield* deps.stopPendingWake(m.pendingWake);
                    return yield* protocolError(
                      "Native Pi work started while rollback was changing the session",
                    );
                  }
                  if (
                    m.threadState !== state ||
                    state.activeTurn !== null ||
                    m.closed ||
                    m.stopRequested
                  )
                    return yield* protocolError(
                      "Pi rollback ownership changed during its fork",
                    );
                  m.lastNativeThreadId = forkSessionFile;
                  m.appliedModel = null;
                  m.appliedThinking = null;
                  m.appliedSessionName = null;
                  m.lastKnownLeaf = leafId;
                  m.leafCursorStale = entriesData === undefined;
                  yield* deps.updateProviderThread(state, {
                    nativeThreadRef: providerRef(forkSessionFile),
                    nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                  });
                  m.rollbackBarrier = null;
                  return piThreadSnapshot(state.providerThread);
                }),
              );
            }).pipe(Effect.onInterrupt(() => connection.terminate)),
          (barrier) =>
            Effect.sync(() => {
              if (m.rollbackBarrier === barrier) m.rollbackBarrier = null;
            }),
        );
      },
      (effect, rollbackInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: PI_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause,
              }),
          ),
        ),
    ),
    forkThread: Effect.fn("PiAdapter.forkThread")(
      function* (forkInput) {
        if (m.threadState?.activeTurn != null) {
          return yield* protocolError("Cannot fork while a Pi turn is active");
        }
        const source = forkInput.sourceProviderThread;
        const sourceFile = source.nativeThreadRef?.nativeId;
        if (sourceFile == null)
          return yield* protocolError("Pi fork source has no session file");
        const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
          (turn) => turn.providerThreadId === source.id,
        );
        const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
        if (forkInput.providerTurnId !== undefined && target === undefined) {
          return yield* protocolError("Pi fork target turn is missing");
        }
        const boundary: PiForkBoundary =
          target === undefined
            ? { type: "nothing" }
            : piForkBoundary({
                target: { type: "provider_turn", providerTurn: target },
                providerThreadTurns: sourceTurns,
              });
        // CLI --fork uses Pi's own session format and sets the destination cwd. RPC
        // switch_session/clone alone would retain the source cwd.
        const forkLaunch = buildPiRpcLaunch({
          launchArgs: resolvedLaunchArgs.args,
          environment: options.environment,
          mcpSession: undefined,
          extensionPath: undefined,
          shortLived: true,
          disableExtensions: true,
          disableTools: true,
        });
        const nativeId = yield* Effect.scoped(
          Effect.gen(function* () {
            const forkConnection = yield* makePiRpcConnection({
              command: options.settings.binaryPath || "pi",
              args: [...forkLaunch.args, "--fork", sourceFile],
              cwd,
              env: forkLaunch.env,
            });
            yield* Stream.fromQueue(forkConnection.events).pipe(
              Stream.runDrain,
              Effect.ignore,
              Effect.forkScoped,
            );
            const beforeEntry =
              boundary.type === "nothing"
                ? null
                : yield* piForkEntry(
                    boundary,
                    source.createdAt,
                    forkConnection.request({ type: "get_entries" }),
                  );
            if (beforeEntry !== null) {
              const result = yield* forkConnection.request({
                type: "fork",
                entryId: beforeEntry,
              });
              if (recordField(result, "cancelled") === true) {
                return yield* protocolError("A Pi extension cancelled the session fork");
              }
            }
            const state = yield* forkConnection.request({ type: "get_state" });
            const file = recordString(state, "sessionFile");
            if (file === undefined || file === sourceFile) {
              return yield* protocolError("Pi fork did not create a distinct session file");
            }
            return file;
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const now = yield* DateTime.now;
        return yield* deps.registerThread(
          {
            threadId: forkInput.targetThreadId,
            modelSelection: forkInput.modelSelection ?? input.modelSelection,
            runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: {
              ...source,
              id: idAllocator.derive.providerThread({
                driver: PI_PROVIDER,
                nativeThreadId: nativeId,
              }),
              appThreadId: forkInput.targetThreadId,
              providerSessionId: input.providerSessionId,
              providerInstanceId: options.instanceId,
              ownerNodeId: forkInput.ownerNodeId ?? null,
              nativeThreadRef: providerRef(nativeId),
              nativeConversationHeadRef: null,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              pendingBackgroundTasks: [],
              forkedFrom: {
                providerThreadId: source.id,
                ...(forkInput.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: forkInput.providerTurnId }),
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          false,
        );
      },
      (effect, forkInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: PI_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
          ),
        ),
    ),
  };
  return runtime;
};

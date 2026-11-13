/**
 * Pi provider session state: services, mutable cells and the small request helpers every layer closes over.
 */
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { parsePiCompactCommand, type PiCompactCommand } from "../commands.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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
import * as Scope from "effect/Scope";
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

export interface PiSessionStateDeps {
  readonly options: PiAdapterV2Options;
  readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  readonly connection: PiRpcConnection;
  readonly resolvedLaunchArgs: Extract<ReturnType<typeof resolvePiLaunchArgs>, { readonly ok: true }>;
  readonly spawner: (typeof ChildProcessSpawner.ChildProcessSpawner)["Service"];
  readonly cwd: string;
  readonly scope: Scope.Scope;
  readonly fileSystem: (typeof FileSystem.FileSystem)["Service"];
  readonly idAllocator: (typeof IdAllocator.IdAllocatorV2)["Service"];
  readonly host: (typeof ProviderHost.ProviderHost)["Service"];
  readonly mcpSessions: (typeof McpProviderSessions.McpProviderSessions)["Service"];
  readonly continuationRequests: PiAdapterV2Options["continuationRequests"];
}

export const createPiSessionState = Effect.fnUntraced(function* (deps: PiSessionStateDeps) {
  const {
    options,
    input,
    connection,
    resolvedLaunchArgs,
    spawner,
    cwd,
    scope,
    fileSystem,
    idAllocator,
    host,
    mcpSessions,
    continuationRequests,
  } = deps;
  const now = yield* DateTime.now;
  let sessionEntity: OrchestrationV2ProviderSession = {
    id: input.providerSessionId,
    driver: PI_PROVIDER,
    providerInstanceId: options.instanceId,
    status: "ready",
    cwd,
    model: input.modelSelection.model,
    capabilities: PiProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const events = yield* Queue.unbounded<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error | Cause.Done
  >();
  const pendingPrompts = new Map<string, PendingPiPrompt>();
  const sessionApprovals = new Set<string>();
  // Pi can settle immediately after dialog response; serialize so terminal cannot overtake request resolution.
  const sessionEventPermit = yield* Semaphore.make(1);
  let threadState: PiThreadState | null = null;
  let registrationAttempted = false;
  let lastNativeThreadId: string | null = null;
  let stopRequested = false;
  let unsolicitedActivityDetected = false;
  let pendingWake: PiWake | null = null;
  let rollbackBarrier: Deferred.Deferred<
    void,
    ProviderAdapter.ProviderAdapterProtocolError
  > | null = null;
  let closed = false;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      pendingWake = null;
      if (rollbackBarrier !== null)
        yield* Deferred.fail(
          rollbackBarrier,
          protocolError("Pi session closed during rollback"),
        );
    }),
  );
  let appliedModel: string | null = null;
  let appliedThinking: string | null = null;
  let appliedSessionName: string | null = null;
  const outOfTurnExtensionErrors: Array<PiRpcRecord> = [];
  let lastKnownLeaf: string | null = null;
  // Failed get_entries leaves an untrustworthy turn boundary; re-sync the cursor on next capture.
  let leafCursorStale = false;
  // Pi has no unset commands; capture initial defaults so Pi default can replay them.
  let baselineModel: { provider: string; modelId: string } | null = null;
  let baselineThinking: string | null = null;
  let contextWindow: number | null = null;
  const modelContextWindows = new Map<string, number>();
  let modelsDiscovered = false;
  // Prompt ACKs lack IDs; retain session send order and ownership so late ACKs cannot affect new turns.
  const pendingPromptResponses: Array<PiPromptSend> = [];
  const pendingCompactResponses: Array<{
    readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
    readonly kind: "turn_start" | "steer";
  }> = [];
  // Pi rejects every prompt while it compacts, including compaction an
  // extension starts after the turn settled. Hold prompts until it ends.
  let nativeCompacting = false;
  const heldPrompts: Array<PiPromptSend> = [];
  // Prompts sent before the pump observed compaction_start are rejected
  // after it; they precede every prompt held since.
  let rejectedHeldCount = 0;

  const sendPrompt = Effect.fnUntraced(function* (prompt: PiPromptSend) {
    if (nativeCompacting) {
      heldPrompts.push(prompt);
      return;
    }
    yield* connection.send(prompt.record);
    pendingPromptResponses.push(prompt);
  });
  // A just-released prompt has not started its run yet, so a settle probe
  // racing it would see Pi idle. Its ack re-arms the probe instead.
  let releasedPromptTurnId: OrchestrationV2ProviderTurn["id"] | null = null;

  const compactRpcRecord = (command: PiCompactCommand): PiRpcRecord =>
    command.customInstructions === undefined
      ? { type: "compact" }
      : { type: "compact", customInstructions: command.customInstructions };

  const request = (record: PiRpcRecord, timeoutMs = PI_REQUEST_TIMEOUT_MS) =>
    connection.request(record, timeoutMs);

  const lifecycleRequest = (record: PiRpcRecord) =>
    request(record, PI_SESSION_TIMEOUT_MS).pipe(
      // Timeout does not cancel Pi's lifecycle hook; retire the process before fallback can race it.
      Effect.tapError((error) =>
        Effect.logWarning("Pi session lifecycle request failed", {
          providerSessionId: input.providerSessionId,
          operation: record["type"],
          errorTag: error._tag,
        }),
      ),
      Effect.catchTags({
        PiRpcTimeoutError: (error) =>
          connection.terminate.pipe(Effect.andThen(Effect.fail(error))),
      }),
      Effect.onInterrupt(() => connection.terminate),
    );

  return {
    options,
    input,
    connection,
    resolvedLaunchArgs,
    spawner,
    cwd,
    scope,
    fileSystem,
    idAllocator,
    host,
    mcpSessions,
    continuationRequests,
    now,
    events,
    pendingPrompts,
    sessionApprovals,
    sessionEventPermit,
    outOfTurnExtensionErrors,
    modelContextWindows,
    pendingPromptResponses,
    pendingCompactResponses,
    heldPrompts,
    sendPrompt,
    compactRpcRecord,
    request,
    lifecycleRequest,
    mutable: {
      get sessionEntity() {
        return sessionEntity;
      },
      set sessionEntity(value) {
        sessionEntity = value;
      },
      get threadState() {
        return threadState;
      },
      set threadState(value) {
        threadState = value;
      },
      get registrationAttempted() {
        return registrationAttempted;
      },
      set registrationAttempted(value) {
        registrationAttempted = value;
      },
      get lastNativeThreadId() {
        return lastNativeThreadId;
      },
      set lastNativeThreadId(value) {
        lastNativeThreadId = value;
      },
      get stopRequested() {
        return stopRequested;
      },
      set stopRequested(value) {
        stopRequested = value;
      },
      get unsolicitedActivityDetected() {
        return unsolicitedActivityDetected;
      },
      set unsolicitedActivityDetected(value) {
        unsolicitedActivityDetected = value;
      },
      get pendingWake() {
        return pendingWake;
      },
      set pendingWake(value) {
        pendingWake = value;
      },
      get rollbackBarrier() {
        return rollbackBarrier;
      },
      set rollbackBarrier(value) {
        rollbackBarrier = value;
      },
      get closed() {
        return closed;
      },
      set closed(value) {
        closed = value;
      },
      get appliedModel() {
        return appliedModel;
      },
      set appliedModel(value) {
        appliedModel = value;
      },
      get appliedThinking() {
        return appliedThinking;
      },
      set appliedThinking(value) {
        appliedThinking = value;
      },
      get appliedSessionName() {
        return appliedSessionName;
      },
      set appliedSessionName(value) {
        appliedSessionName = value;
      },
      get lastKnownLeaf() {
        return lastKnownLeaf;
      },
      set lastKnownLeaf(value) {
        lastKnownLeaf = value;
      },
      get leafCursorStale() {
        return leafCursorStale;
      },
      set leafCursorStale(value) {
        leafCursorStale = value;
      },
      get baselineModel() {
        return baselineModel;
      },
      set baselineModel(value) {
        baselineModel = value;
      },
      get baselineThinking() {
        return baselineThinking;
      },
      set baselineThinking(value) {
        baselineThinking = value;
      },
      get contextWindow() {
        return contextWindow;
      },
      set contextWindow(value) {
        contextWindow = value;
      },
      get modelsDiscovered() {
        return modelsDiscovered;
      },
      set modelsDiscovered(value) {
        modelsDiscovered = value;
      },
      get nativeCompacting() {
        return nativeCompacting;
      },
      set nativeCompacting(value) {
        nativeCompacting = value;
      },
      get rejectedHeldCount() {
        return rejectedHeldCount;
      },
      set rejectedHeldCount(value) {
        rejectedHeldCount = value;
      },
      get releasedPromptTurnId() {
        return releasedPromptTurnId;
      },
      set releasedPromptTurnId(value) {
        releasedPromptTurnId = value;
      },
    },
  };
});

export type State = Effect.Success<ReturnType<typeof createPiSessionState>>;

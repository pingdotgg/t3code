/**
 * Research observation bridge (Oracle MVP T6).
 *
 * Delegates longer questions to T3 threads on configurable worker profiles,
 * returns the thread/task identity immediately (quick receipt; the
 * observation loop never blocks the caller or the live client), and delivers
 * the finished result into the live session exactly once per
 * (threadId, turnId) — the frozen delivery key, never repeated session
 * status — with event-driven recovery after a voice disconnect.
 *
 * Delivery channels (T3-CONTRACTS "Delivery contract"):
 *  - "commentary": the fetched result text is appended via
 *    session.commentary.append with delegation_id: null. This assumes the
 *    Responses backend sees commentary context — R4 is unverified (T1 gate
 *    live_access_unavailable), so this channel is not the default.
 *  - "fallback" (default): the bridge fetches the delivered thread identity's
 *    final result via voice.readThread and steers a message carrying the
 *    thread identity plus the fetched result, so the model speaks it and the
 *    backend can re-read the thread through the identity if context is
 *    missing. Which channel actually carries context into the backend stays
 *    a live gate for T7.
 * Both channels are the documented unsolicited steering event; delegation
 * modes are never mixed and a completed Responses delegation id is never
 * reused (delegation_id is always null).
 *
 * Profile configuration mechanism (recorded design): worker profiles resolve
 * from a plain JSON `VoiceWorkerProfilesConfig` following the same
 * JSON-override pattern as the broker's `voice-broker-config` server secret
 * (apps/server/src/voice/broker.ts), supplied to the bridge through the
 * injected `profiles` loader. This is the smallest client-readable mechanism:
 * the browser client cannot read server secrets, so T7 wires the loader to
 * the client's configuration delivery. An unconfigured profile fails with
 * model_unavailable and never silently falls back to another model.
 */
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  VoiceRequestId,
  VoiceStartThreadOutput,
  VoiceTimingMark,
  VoiceToolError,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  classifyEnvironmentFailure,
  evaluateModelAvailability,
  VoiceToolFailureError,
  type VoiceToolExecutor,
  type VoiceToolHost,
} from "./tools";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Observation cadence. Each step is one observeThread call (a thread
    subscription first item plus one bounded detail read), so the interval
    stays coarse; completion latency is bounded by this cadence. */
export const DEFAULT_RESEARCH_POLL_INTERVAL_MS = 2_000;

/** The documented append limit is 500 tokens; readThread already truncates
    turn text at 2000 characters. The composed steering content is truncated
    to the same bound so the identity wrapper cannot push it past the limit. */
const MAX_STEER_CONTENT_LENGTH = 2000;

/** Window for the fallback result read: the delivered turn is the thread's
    latest, so a small bounded window suffices. */
const RESULT_READ_TURNS = 3;

// ---------------------------------------------------------------------------
// Worker profiles
// ---------------------------------------------------------------------------

export type VoiceWorkerProfileName = "routine" | "deep";

/** One profile's target: a provider instance id plus a model slug, validated
    against the target environment's ServerProvider snapshot before use. */
export interface VoiceWorkerProfileModel {
  readonly instanceId: string;
  readonly model: string;
}

/** Plain JSON profile configuration (voice-broker-config override pattern).
    Both profiles are optional; an unset profile is a configuration gap and
    fails with model_unavailable rather than falling back. */
export interface VoiceWorkerProfilesConfig {
  readonly routine?: VoiceWorkerProfileModel;
  readonly deep?: VoiceWorkerProfileModel;
}

/** The worker model a delegation asked for: a named profile, or an explicit
    user-stated instance/model that bypasses profile configuration. */
export type VoiceWorkerModelRequest =
  | { readonly kind: "profile"; readonly profile: VoiceWorkerProfileName }
  | { readonly kind: "explicit"; readonly instanceId: string; readonly model: string };

/** Resolves the model selection for one delegation. Throws VoiceToolFailureError
    (model_unavailable) when the named profile is not configured — never a
    silent fallback to another model. Explicit selections pass through
    unchanged and are validated against the environment separately. */
export function resolveWorkerModelSelection(
  request: VoiceWorkerModelRequest,
  config: VoiceWorkerProfilesConfig,
): VoiceWorkerProfileModel {
  if (request.kind === "explicit") {
    return { instanceId: request.instanceId, model: request.model };
  }
  const resolved = config[request.profile];
  if (resolved === undefined) {
    throw new VoiceToolFailureError({
      code: "model_unavailable",
      message: `Worker profile "${request.profile}" is not configured; no fallback model is used.`,
      model: request.profile,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Delivery records (the pending-delivery mapping)
// ---------------------------------------------------------------------------

/** A persisted pending-delivery mapping entry, keyed by the VoiceRequestId.
    T5's durable-mechanism style: identity is derived (threadId from the
    request id), while server-owned facts (turnId, event sequence) are
    recorded here as observation advances. `status` "watching" means the
    bridge is (or should be, after reconnect) observing; "auth_invalid" and
    "failed" are terminal and stop the retry loops. */
export interface VoiceDeliveryRecord {
  readonly requestId: VoiceRequestId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** Last observed event sequence; the reconnect resume cursor
      (subscribeThread afterSequence semantics). Initialized from the
      creation dispatch receipt sequence. */
  afterSequence: number;
  status: "watching" | "auth_invalid" | "failed";
  /** Delivered (threadId, turnId) keys — the exactly-once ledger. */
  readonly deliveredTurnIds: string[];
  lastError?: string;
}

/** Pluggable persistence for delivery records. The default is in-memory
    (one bridge instance survives voice reconnects); a real store makes the
    pending mapping survive a full client restart. */
export interface VoiceDeliveryStore {
  load(): Promise<ReadonlyArray<VoiceDeliveryRecord>>;
  save(record: VoiceDeliveryRecord): Promise<void> | void;
}

export function createInMemoryVoiceDeliveryStore(): VoiceDeliveryStore {
  const records = new Map<VoiceRequestId, VoiceDeliveryRecord>();
  return {
    async load() {
      return [...records.values()].map(cloneRecord);
    },
    async save(record) {
      records.set(record.requestId, cloneRecord(record));
    },
  };
}

function cloneRecord(record: VoiceDeliveryRecord): VoiceDeliveryRecord {
  return { ...record, deliveredTurnIds: [...record.deliveredTurnIds] };
}

const deliveryKey = (threadId: ThreadId, turnId: TurnId): string => `${threadId}:${turnId}`;

// ---------------------------------------------------------------------------
// Bridge events
// ---------------------------------------------------------------------------

export type VoiceResearchBridgeEvent =
  | {
      readonly type: "delegation_started";
      readonly requestId: VoiceRequestId;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly model: VoiceWorkerProfileModel;
    }
  | {
      readonly type: "delivered";
      readonly requestId: VoiceRequestId;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly channel: ResearchDeliveryChannel;
    }
  | {
      readonly type: "delivery_deferred";
      readonly requestId: VoiceRequestId;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    }
  | {
      readonly type: "error";
      readonly requestId: VoiceRequestId;
      readonly threadId: ThreadId;
      readonly error: VoiceToolError;
    }
  | {
      readonly type: "auth_invalid";
      readonly requestId: VoiceRequestId;
      readonly threadId: ThreadId;
      readonly error: VoiceToolError;
    };

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export type ResearchDeliveryChannel = "fallback" | "commentary";

export interface VoiceResearchBridgeDependencies {
  readonly host: VoiceToolHost;
  /** The T2/T5 executor slice the bridge delegates and observes through.
      The bridge adds no authority: it never dispatches commands and passes
      the creation input through without a runtimeMode (the normal T3 default
      applies, T5's path untouched). */
  readonly executor: Pick<VoiceToolExecutor, "startThread" | "observeThread" | "readThread">;
  /** Worker-profile configuration, plain or loaded lazily. */
  readonly profiles:
    | VoiceWorkerProfilesConfig
    | (() => Promise<VoiceWorkerProfilesConfig> | VoiceWorkerProfilesConfig);
  /** Sends application steering into the live session — live-client's
      `steer` (session.commentary.append, delegation_id: null). Returning
      false (or being absent) defers delivery; the record stays pending for
      reconnect recovery. */
  readonly steer?: (content: string) => boolean;
  /** T4's mark-bus indirection. The bridge emits the frozen marks around
      observed research progress (in-flight on a running observation, done at
      the turn's terminal observation) instead of a parallel mark system. */
  readonly emitMark?: (mark: VoiceTimingMark, detail?: string) => void;
  readonly now?: () => number;
  /** Injectable scheduler (defaults to setTimeout); tests drive steps
      manually. The returned cancel stops a pending step. */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  readonly pollIntervalMs?: number;
  readonly store?: VoiceDeliveryStore;
  /** Default "fallback" per the frozen delivery contract (R4 unverified). */
  readonly deliveryChannel?: ResearchDeliveryChannel;
}

export interface VoiceResearchBridge {
  /** Delegates one longer question. Resolves with the startThread receipt
      (thread/task identity) as soon as the creation path read back — never
      waiting on worker completion. Validation failures (unconfigured
      profile, model_unavailable, unreachable environment) throw
      VoiceToolFailureError. */
  delegate(input: {
    readonly requestId: VoiceRequestId;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly task: string;
    readonly model: VoiceWorkerModelRequest;
    readonly title?: string;
  }): Promise<VoiceStartThreadOutput>;
  /** Re-arms observation for persisted records that are still watching
      (voice reconnect or client restart). Records with a live or scheduled
      observation step are left alone. Returns the number resumed. */
  recover(): Promise<number>;
  onEvent(listener: (event: VoiceResearchBridgeEvent) => void): () => void;
  /** Stops all observation loops and clears pending scheduled steps. */
  dispose(): void;
}

export function createResearchBridge(
  dependencies: VoiceResearchBridgeDependencies,
): VoiceResearchBridge {
  const {
    host,
    executor,
    profiles,
    steer,
    emitMark,
    schedule = (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    },
    pollIntervalMs = DEFAULT_RESEARCH_POLL_INTERVAL_MS,
    store = createInMemoryVoiceDeliveryStore(),
    deliveryChannel = "fallback",
  } = dependencies;

  const listeners = new Set<(event: VoiceResearchBridgeEvent) => void>();
  const records = new Map<VoiceRequestId, VoiceDeliveryRecord>();
  /** Delivery keys with an attempt in flight; guards duplicate terminal
      events racing an await. */
  const delivering = new Set<string>();
  /** Per-record observation loop state: a scheduled (pending) step's cancel
      and a step currently executing. At most one loop runs per record. */
  const scheduledSteps = new Map<VoiceRequestId, () => void>();
  const runningSteps = new Set<VoiceRequestId>();
  const timers = new Set<() => void>();
  const markInFlight = new Set<VoiceRequestId>();
  let disposed = false;

  const emit = (event: VoiceResearchBridgeEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const persist = async (record: VoiceDeliveryRecord) => {
    await store.save(cloneRecord(record));
  };

  const resolveProfiles = async (): Promise<VoiceWorkerProfilesConfig> =>
    typeof profiles === "function" ? await profiles() : profiles;

  const requireProviders = async (environmentId: EnvironmentId) => {
    const entry = host.catalogEnvironments().find((e) => e.environmentId === environmentId);
    if (entry === undefined) {
      throw new VoiceToolFailureError({
        code: "environment_not_in_catalog",
        message: `Environment "${environmentId}" is not in this client's connection catalog.`,
        environmentId,
      });
    }
    const access = host.openEnvironment(environmentId);
    if (access === null) {
      throw new VoiceToolFailureError({
        code: "environment_unreachable",
        message: `Could not reach environment "${entry.label}" because it is not connected.`,
        environmentId,
      });
    }
    try {
      return await access.serverConfig();
    } catch (cause) {
      throw new VoiceToolFailureError(classifyEnvironmentFailure(cause));
    }
  };

  const scheduleStep = (record: VoiceDeliveryRecord, delayMs: number) => {
    if (disposed || scheduledSteps.has(record.requestId)) {
      return;
    }
    const cancel = schedule(() => {
      timers.delete(cancel);
      scheduledSteps.delete(record.requestId);
      void observeStep(record);
    }, delayMs);
    timers.add(cancel);
    scheduledSteps.set(record.requestId, cancel);
  };

  const setMarkInFlight = (record: VoiceDeliveryRecord, inFlight: boolean) => {
    if (emitMark === undefined) {
      return;
    }
    const detail = `research:${record.threadId}`;
    if (inFlight && !markInFlight.has(record.requestId)) {
      markInFlight.add(record.requestId);
      emitMark("function_call_received", detail);
    } else if (!inFlight && markInFlight.has(record.requestId)) {
      markInFlight.delete(record.requestId);
      emitMark("tool_done", detail);
    }
  };

  const stopOnAuthInvalid = (record: VoiceDeliveryRecord, failure: VoiceToolError) => {
    record.status = "auth_invalid";
    record.lastError = failure.message;
    setMarkInFlight(record, false);
    void persist(record);
    // A revoked session stops the retry loop entirely; recovery on a new
    // session is a fresh delegation, not a resumed one.
    emit({
      type: "auth_invalid",
      requestId: record.requestId,
      threadId: record.threadId,
      error: failure,
    });
  };

  const workerErrorNotice = (lastError: string | null): string =>
    lastError === null || lastError.trim().length === 0
      ? "The background research could not be completed because the worker reported an error."
      : `The background research could not be completed: ${lastError}`;

  /** Reads the delivered thread identity's final result and steers it into
      the conversation. "delivered" means the steering channel accepted the
      content and the (threadId, turnId) key is recorded; "deferred" means
      steering was unavailable and the delivery stays pending for reconnect
      recovery; "retry" means a transient failure — keep observing. */
  const deliverTurnResult = async (
    record: VoiceDeliveryRecord,
    turnId: TurnId,
  ): Promise<"delivered" | "deferred" | "retry"> => {
    const key = deliveryKey(record.threadId, turnId);
    if (record.deliveredTurnIds.includes(key) || delivering.has(key)) {
      return "delivered";
    }
    delivering.add(key);
    try {
      let read;
      try {
        read = await executor.readThread({
          environmentId: record.environmentId,
          threadId: record.threadId,
          turnLimit: RESULT_READ_TURNS,
        });
      } catch (cause) {
        // readThread throws only for boundary failures (T2 projects tool
        // failures in-band); treat them as transient unless revoked.
        const failure =
          cause instanceof VoiceToolFailureError ? cause.error : classifyEnvironmentFailure(cause);
        if (failure.code === "auth_invalid") {
          stopOnAuthInvalid(record, failure);
          return "retry";
        }
        emit({
          type: "error",
          requestId: record.requestId,
          threadId: record.threadId,
          error: failure,
        });
        return "retry";
      }
      if (read.environment.status !== "ok" || read.thread === undefined) {
        const failure: VoiceToolError = read.environment.error ?? {
          code: "environment_unreachable",
          message: "The result read returned no thread.",
        };
        if (failure.code === "auth_invalid") {
          stopOnAuthInvalid(record, failure);
          return "retry";
        }
        emit({
          type: "error",
          requestId: record.requestId,
          threadId: record.threadId,
          error: failure,
        });
        return "retry";
      }

      const turns = read.thread.turns;
      const turn =
        [...turns].filter((candidate) => candidate.turnId === turnId).at(-1) ??
        [...turns].reverse().find((candidate) => candidate.assistantText !== null);
      const resultText = turn?.assistantText ?? null;
      const title = read.thread.title;
      let content: string;
      if (resultText === null) {
        // A finished turn without a final message is reported as a readable
        // failure — never silence, never a fabricated result.
        content = `The background research thread "${title}" finished without a final result message.`;
      } else if (deliveryChannel === "commentary") {
        content = resultText;
      } else {
        content =
          `Background research finished for thread "${title}" (thread ${record.threadId}, ` +
          `turn ${turnId}). Result: ${resultText} If you need more detail, read that ` +
          `thread with the voice.readThread tool using this identity.`;
      }
      if (content.length > MAX_STEER_CONTENT_LENGTH) {
        content = `${content.slice(0, MAX_STEER_CONTENT_LENGTH)}…`;
      }
      const sent = steer === undefined ? false : steer(content);
      if (!sent) {
        // The voice session cannot accept steering (ended or not live). The
        // record stays watching: reconnect recovery re-reads the durable
        // thread and delivers once.
        emit({
          type: "delivery_deferred",
          requestId: record.requestId,
          threadId: record.threadId,
          turnId,
        });
        return "deferred";
      }
      record.deliveredTurnIds.push(key);
      delete record.lastError;
      await persist(record);
      emit({
        type: "delivered",
        requestId: record.requestId,
        threadId: record.threadId,
        turnId,
        channel: deliveryChannel,
      });
      return "delivered";
    } finally {
      delivering.delete(key);
    }
  };

  const reportWorkerError = (
    record: VoiceDeliveryRecord,
    lastError: string | null,
    turnId: TurnId | undefined,
    steered: boolean,
  ) => {
    if (steered && turnId !== undefined) {
      // The failure notice is this turn's delivery; record the key so a
      // recovery cannot deliver the same notice twice.
      const key = deliveryKey(record.threadId, turnId);
      if (!record.deliveredTurnIds.includes(key)) {
        record.deliveredTurnIds.push(key);
      }
    }
    record.lastError = lastError ?? "worker error";
    if (steered) {
      record.status = "failed";
    }
    setMarkInFlight(record, false);
    void persist(record);
    emit({
      type: "error",
      requestId: record.requestId,
      threadId: record.threadId,
      error: {
        code: "partial_failure",
        message: `Worker reported an error${lastError === null ? "." : `: ${lastError}`}`,
        environmentId: record.environmentId,
        threadId: record.threadId,
      },
    });
  };

  /** One observation cycle. Returns true when the loop should continue
      polling; false when it must suspend (deferred delivery) or has gone
      terminal (worker failure delivered, or auth_invalid). */
  const runObservationStep = async (record: VoiceDeliveryRecord): Promise<boolean> => {
    if (disposed || record.status !== "watching") {
      return false;
    }
    let observation;
    try {
      observation = await executor.observeThread({
        environmentId: record.environmentId,
        threadId: record.threadId,
        afterSequence: record.afterSequence,
      });
    } catch (cause) {
      const failure =
        cause instanceof VoiceToolFailureError ? cause.error : classifyEnvironmentFailure(cause);
      if (failure.code === "auth_invalid") {
        stopOnAuthInvalid(record, failure);
        return false;
      }
      // Transient boundary failure: report it and keep observing.
      emit({
        type: "error",
        requestId: record.requestId,
        threadId: record.threadId,
        error: failure,
      });
      return true;
    }

    record.afterSequence = Math.max(record.afterSequence, observation.sequence);
    setMarkInFlight(record, observation.running);

    if (observation.session.status === "error") {
      // Worker failure: surface it in-band on the delivery (a readable
      // failure notice the model speaks) plus the client error path. When
      // steering is unavailable the record stays watching so reconnect
      // recovery re-observes and delivers the notice once.
      const sent =
        steer === undefined ? false : steer(workerErrorNotice(observation.session.lastError));
      reportWorkerError(record, observation.session.lastError, observation.turnId, sent);
      return false;
    }

    if (!observation.running && observation.turnId !== undefined) {
      const outcome = await deliverTurnResult(record, observation.turnId);
      // A deferred delivery suspends polling; reconnect recovery re-arms.
      // A delivered turn keeps the loop alive: a later turn on the same
      // thread is a separate delivery under its own key.
      return outcome === "retry" || outcome === "delivered";
    }

    return true;
  };

  const observeStep = async (record: VoiceDeliveryRecord) => {
    if (disposed || runningSteps.has(record.requestId) || record.status !== "watching") {
      return;
    }
    runningSteps.add(record.requestId);
    let resume = false;
    try {
      resume = await runObservationStep(record);
    } finally {
      runningSteps.delete(record.requestId);
    }
    if (resume && record.status === "watching" && !disposed) {
      scheduleStep(record, pollIntervalMs);
    }
  };

  const watchRecord = (record: VoiceDeliveryRecord) => {
    if (
      disposed ||
      record.status !== "watching" ||
      scheduledSteps.has(record.requestId) ||
      runningSteps.has(record.requestId)
    ) {
      return;
    }
    scheduleStep(record, 0);
  };

  return {
    async delegate(input) {
      const task = input.task.trim();
      if (task.length === 0) {
        throw new VoiceToolFailureError({
          code: "invalid_request",
          message: "Task text is required to delegate research.",
        });
      }
      const config = await resolveProfiles();
      const selection = resolveWorkerModelSelection(input.model, config);
      // Pre-validation against the target environment's current provider
      // snapshot. Unavailable models fail model_unavailable before any
      // dispatch — never a silent fallback to another model.
      const providers = (await requireProviders(input.environmentId)).providers;
      const availability = evaluateModelAvailability(
        providers,
        selection.instanceId,
        selection.model,
      );
      if (!availability.available) {
        throw new VoiceToolFailureError({
          code: "model_unavailable",
          message: availability.reason,
          environmentId: input.environmentId,
          model: selection.model,
        });
      }

      // Creation goes through T5's startThread path untouched: no
      // runtimeMode here (the normal T3 default applies), no dispatch of our
      // own, and the receipt resolves without waiting for the worker.
      const output = await executor.startThread({
        requestId: input.requestId,
        environmentId: input.environmentId,
        projectId: input.projectId,
        task,
        modelSelection: {
          instanceId: ProviderInstanceId.make(selection.instanceId),
          model: selection.model,
        },
        ...(input.title !== undefined ? { title: input.title } : {}),
      });

      const record: VoiceDeliveryRecord = {
        requestId: input.requestId,
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: output.threadId,
        // The creation read-back anchor is the dispatch receipt sequence.
        afterSequence: output.dispatchSequence,
        status: "watching",
        deliveredTurnIds: [],
      };
      records.set(input.requestId, record);
      await persist(record);
      emit({
        type: "delegation_started",
        requestId: input.requestId,
        environmentId: input.environmentId,
        threadId: output.threadId,
        model: selection,
      });
      watchRecord(record);
      return output;
    },

    async recover() {
      const stored = await store.load();
      let resumed = 0;
      for (const storedRecord of stored) {
        if (storedRecord.status !== "watching") {
          continue;
        }
        const existing = records.get(storedRecord.requestId);
        if (existing === undefined) {
          const revived = cloneRecord(storedRecord);
          records.set(revived.requestId, revived);
          watchRecord(revived);
          resumed += 1;
        } else if (
          existing.status === "watching" &&
          !scheduledSteps.has(existing.requestId) &&
          !runningSteps.has(existing.requestId)
        ) {
          // Same bridge instance after a voice reconnect: re-arm the
          // suspended polling loop. The delivered ledger prevents any
          // duplicate delivery.
          watchRecord(existing);
          resumed += 1;
        }
      }
      return resumed;
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      for (const cancel of timers) {
        cancel();
      }
      timers.clear();
      scheduledSteps.clear();
      for (const requestId of markInFlight) {
        const record = records.get(requestId);
        if (record !== undefined) {
          setMarkInFlight(record, false);
        }
      }
      markInFlight.clear();
    },
  };
}

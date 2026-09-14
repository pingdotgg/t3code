/**
 * Browser-side GPT Live client over the environment voice broker.
 *
 * The client owns the WebRTC leg: it creates the peer connection, mints the
 * Live session through the broker route (the environment's OpenAI key never
 * reaches the browser), waits for `session.started` on the `oai-events` data
 * channel, runs the delegated function loop against an injected tool
 * executor, and closes with `session.close` -> `session.closed`. It never
 * sends `session.start` on the WebRTC data channel (over a raw WebSocket
 * transport the first event must be `session.start` — a transport this
 * module deliberately does not implement; see T3-CONTRACTS Part C).
 *
 * Every browser capability the tests cannot provide (RTCPeerConnection, the
 * broker HTTP calls, the tool executor, the clock) is injected, so the whole
 * lifecycle is testable without network or media hardware.
 */
import type {
  VoiceBrokerSessionCloseInput,
  VoiceBrokerSessionCloseResult,
  VoiceBrokerSessionCreated,
  VoiceBrokerSessionRequest,
  VoiceSessionId,
  VoiceSessionUsage,
  VoiceTimingMark,
  VoiceTimingMarkRecord,
  VoiceToolError,
  VoiceToolErrorCode,
  VoiceBackendRequest,
  VoiceBackendResult,
} from "@t3tools/contracts";

// ---------------------------------------------------------------------------
// Injected browser boundaries
// ---------------------------------------------------------------------------

export interface VoiceLiveMediaStreamTrack {
  readonly kind: string;
  stop(): void;
}

export interface VoiceLiveRtcDataChannel {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export interface VoiceLiveSessionDescription {
  readonly type: string;
  readonly sdp: string;
}

export interface VoiceLiveRtcPeerConnection {
  createDataChannel(label: string): VoiceLiveRtcDataChannel;
  createOffer(): Promise<VoiceLiveSessionDescription>;
  setLocalDescription(description: VoiceLiveSessionDescription): Promise<void>;
  setRemoteDescription(description: VoiceLiveSessionDescription): Promise<void>;
  addTrack(track: VoiceLiveMediaStreamTrack): void;
  close(): void;
  readonly connectionState: string;
  ontrack:
    | ((event: {
        readonly track: VoiceLiveMediaStreamTrack;
        readonly streams: ReadonlyArray<unknown>;
      }) => void)
    | null;
  onconnectionstatechange: (() => void) | null;
}

/** Production peer connection factory for browsers. */
export const defaultPeerConnectionFactory = (): VoiceLiveRtcPeerConnection =>
  new RTCPeerConnection() as unknown as VoiceLiveRtcPeerConnection;

/** Broker route port (see apps/server/src/voice/broker.ts). Failures reject
    with a VoiceToolError carrying a frozen code. */
export interface VoiceLiveBrokerPort {
  respond?(input: VoiceBackendRequest): Promise<VoiceBackendResult>;
  mintSession(request: VoiceBrokerSessionRequest): Promise<VoiceBrokerSessionCreated>;
  closeSession(input: VoiceBrokerSessionCloseInput): Promise<VoiceBrokerSessionCloseResult>;
}

/** Client-owned tool executor (T2's tools.ts implements this). The executor
    validates inputs against the frozen voice tool schemas; the Live client
    only dispatches by name and serializes outputs. The name is the string
    the Live session delivers — the broker advertises tools with a `voice.`
    prefix (`voice.openThread`), so the executor normalizes the prefix. */
export interface VoiceLiveToolExecutor {
  execute(name: string, input: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type VoiceLiveSessionState =
  | "idle"
  | "minting"
  | "connecting"
  | "live"
  | "closing"
  | "closed"
  | "error";

export type VoiceLiveClientEvent =
  | { readonly type: "delegation"; readonly id: string }
  | { readonly type: "command_result"; readonly text: string }
  | { readonly type: "state"; readonly state: VoiceLiveSessionState }
  | { readonly type: "timing"; readonly record: VoiceTimingMarkRecord }
  | {
      readonly type: "transcript";
      readonly channel: "input" | "output";
      readonly delta: string;
    }
  | { readonly type: "usage"; readonly usage: VoiceSessionUsage }
  | { readonly type: "track"; readonly track: VoiceLiveMediaStreamTrack }
  | { readonly type: "error"; readonly error: VoiceToolError };

export interface VoiceLiveClientOptions {
  readonly broker: VoiceLiveBrokerPort;
  readonly createPeerConnection: () => VoiceLiveRtcPeerConnection;
  readonly executor?: VoiceLiveToolExecutor;
  /** Local nonverbal feedback, called only after a confirmed UI action. */
  readonly acknowledgeAction?: () => void;
  readonly onSpeechSuppressionChange?: (suppressed: boolean) => void;
  /** Local microphone track captured by the caller (T4's UI). */
  readonly audioTrack?: VoiceLiveMediaStreamTrack;
  /** Clock for timing marks; defaults to Date.now. */
  readonly now?: () => number;
}

export interface VoiceLiveClient {
  setSpeechSuppressed?(suppressed: boolean): void;
  /** Mints the session and resolves once `session.started` arrived. Rejects
      with a VoiceToolError (frozen code) on mint or transport failure. */
  start(): Promise<{ readonly sessionId: VoiceSessionId }>;
  /** Sends `session.close` on the data channel, waits for `session.closed`
      (or the channel dying), then closes broker accounting. Idempotent. */
  close(): Promise<void>;
  onEvent(listener: (event: VoiceLiveClientEvent) => void): () => void;
  /** Mark-bus escape hatch for consumer-owned marks: T4 emits
      navigation_acknowledged after reading the resulting route; the annotated
      recorded-input endpoint supersedes this client's `utterance_end`. */
  emitMark(mark: VoiceTimingMark, detail?: string): void;
  /** Unsolicited application steering over the `oai-events` data channel:
      `session.commentary.append` with `delegation_id: null` (documented
      application steering; delegation modes are never mixed and a completed
      Responses delegation id is never reused). The content is a plain string
      the model is trained to paraphrase aloud; the Live append limit is 500
      tokens, so callers keep content concise. Returns false — sending
      nothing — when the session cannot accept steering (not live, closing,
      or already closed); callers treat false as "defer delivery". Optional
      on the type so older consumer fixtures remain valid; the production
      client always supplies it. */
  steer?(content: string): boolean;
  /** Queue user text and run the configured Responses backend. */
  sendText?(text: string): boolean;
  getState(): VoiceLiveSessionState;
  getSessionId(): VoiceSessionId | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const asVoiceToolError = (code: VoiceToolErrorCode, message: string): VoiceToolError => ({
  code,
  message,
});

/** Tolerant server event shape: the live payload shapes are unverified (T1
    gate `live_access_unavailable`), so the client keys off documented event
    `type` names and reads everything else defensively. */
interface LiveServerEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const parseServerEvent = (data: unknown): LiveServerEvent | undefined => {
  if (typeof data !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") {
    return undefined;
  }
  return { type: record.type, payload: record };
};

interface LiveFunctionCallItem {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

const toFunctionCallItem = (value: unknown): LiveFunctionCallItem | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.type !== "function_call" ||
    typeof record.call_id !== "string" ||
    typeof record.name !== "string"
  ) {
    return undefined;
  }
  return {
    callId: record.call_id,
    name: record.name,
    arguments: typeof record.arguments === "string" ? record.arguments : "",
  };
};

import { allowsThreadCreation, isUiCommandPrefix } from "./command-policy";

export const createVoiceLiveClient = (options: VoiceLiveClientOptions): VoiceLiveClient => {
  const now = options.now ?? Date.now;
  let state: VoiceLiveSessionState = "idle";
  let sessionId: VoiceSessionId | undefined;
  let peerConnection: VoiceLiveRtcPeerConnection | undefined;
  let dataChannel: VoiceLiveRtcDataChannel | undefined;
  let closedByServer = false;
  let closeRun = false;
  let liveSeen = false;
  let firstOutputDeltaSeen = false;
  let closedWaiter: (() => void) | undefined;
  const listeners = new Set<(event: VoiceLiveClientEvent) => void>();
  // Delegation function-loop state, keyed by the tracked response id. Calls
  // are deduplicated by call_id (duplicate delivery is expected on the data
  // channel); the continuation is deduplicated per response.
  let trackedResponseId: string | undefined;
  let inputTranscript = "";
  const creationByDelegation = new Map<string, boolean>();
  let speechSuppressed = false;
  let navigationConfirmed = false;
  let hasSubstantiveTools = false;
  const setSpeechSuppressed = (suppressed: boolean) => {
    speechSuppressed = suppressed;
    options.onSpeechSuppressionChange?.(suppressed);
  };
  const pendingBatches = new Map<
    string,
    {
      readonly delegationId: string | undefined;
      readonly calls: Map<string, LiveFunctionCallItem>;
      completed: boolean;
      continuationSent: boolean;
    }
  >();

  const emit = (event: VoiceLiveClientEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const setState = (next: VoiceLiveSessionState) => {
    state = next;
    emit({ type: "state", state });
  };

  /** Reads the session state through a function call: control-flow narrowing
      of the `state` variable goes stale across the async boundaries that
      mutate it via setState(). */
  const readState = (): VoiceLiveSessionState => state;

  const emitMark = (
    mark: VoiceTimingMark,
    detail?: string,
    source?: "annotated-input" | "unavailable",
  ) => {
    emit({
      type: "timing",
      record: {
        mark,
        atMs: now(),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(detail === undefined ? {} : { detail }),
        ...(source === undefined ? {} : { source }),
      },
    });
  };

  const fail = (error: VoiceToolError) => {
    emit({ type: "error", error });
    setState("error");
  };

  const sendOnChannel = (payload: unknown): boolean => {
    if (dataChannel === undefined) {
      return false;
    }
    dataChannel.send(JSON.stringify(payload));
    return true;
  };

  const transportLost = (detail: string) => {
    fail(asVoiceToolError("environment_unreachable", detail));
    resolveClosedWaiter();
  };

  const resolveClosedWaiter = () => {
    const waiter = closedWaiter;
    closedWaiter = undefined;
    waiter?.();
  };

  const usageEvent = (usage: Record<string, number>): VoiceSessionUsage => ({
    sessionId: sessionId as VoiceSessionId,
    recordedAt: new Date(now()).toISOString(),
    usage,
  });

  const reportUsage = (usage: unknown) => {
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      return;
    }
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
      if (typeof value === "number") {
        numeric[key] = value;
      }
    }
    emit({ type: "usage", usage: usageEvent(numeric) });
  };

  const runFunctionCall = (item: LiveFunctionCallItem, delegationId?: string): Promise<string> => {
    if (
      ![
        "openThread",
        "searchThreads",
        "discoverEnvironments",
        "discoverProjects",
        "listModels",
      ].includes(item.name.replace(/^voice\./, ""))
    ) {
      hasSubstantiveTools = true;
    }
    if (
      item.name.replace(/^voice\./, "") === "startThread" &&
      (!delegationId || creationByDelegation.get(delegationId) !== true)
    ) {
      return Promise.resolve(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message:
              "No explicit new-thread request. Use readThread or continueThread for an existing thread, or ask which thread. Never create a replacement.",
          },
        }),
      );
    }
    if (options.executor === undefined) {
      return Promise.resolve(
        JSON.stringify({
          error: { code: "invalid_request", message: "No tool executor is configured." },
        }),
      );
    }
    let input: unknown;
    try {
      input = item.arguments.length === 0 ? {} : (JSON.parse(item.arguments) as unknown);
    } catch {
      input = undefined;
    }
    if (input === undefined) {
      return Promise.resolve(
        JSON.stringify({
          error: { code: "invalid_request", message: "Tool arguments were not valid JSON." },
        }),
      );
    }
    // Executor failures become an explicit error output for the model; the
    // conversation continues instead of wedging on one bad call.
    return options.executor
      .execute(item.name, input)
      .then((result) => {
        emitMark("tool_done", item.name);
        if (
          (item.name === "openThread" || item.name === "voice.openThread") &&
          result !== null &&
          typeof result === "object" &&
          "acknowledged" in result &&
          result.acknowledged === true
        ) {
          navigationConfirmed = true;
          setSpeechSuppressed(!hasSubstantiveTools);
          options.acknowledgeAction?.();
        } else if (
          !["searchThreads", "discoverEnvironments", "discoverProjects", "listModels"].includes(
            item.name.replace(/^voice\./, ""),
          )
        ) {
          navigationConfirmed = false;
          setSpeechSuppressed(false);
        }
        return JSON.stringify(result ?? null);
      })
      .catch((cause: unknown) => {
        setSpeechSuppressed(false);
        const causeRecord =
          typeof cause === "object" && cause !== null
            ? (cause as Record<string, unknown>)
            : undefined;
        const code =
          typeof causeRecord?.code === "string"
            ? (causeRecord.code as VoiceToolErrorCode)
            : "partial_failure";
        const message =
          typeof causeRecord?.message === "string"
            ? causeRecord.message
            : `Tool ${item.name} failed.`;
        emit({ type: "error", error: asVoiceToolError(code, message) });
        return JSON.stringify({ error: { code, message } });
      });
  };

  /** Submits every collected function result for a finished response and then
      exactly one continuation `response.create`. Lifecycle snapshots may
      legitimately carry `response.output: []`; results come exclusively from
      collected `response.output_item.done` items, so an empty output array is
      never read as "no calls". Duplicate `response.completed` deliveries and
      races with session close are suppressed. */
  const finalizeResponseBatch = (responseId: string) => {
    const batch = pendingBatches.get(responseId);
    if (batch === undefined || batch.completed) {
      return;
    }
    batch.completed = true;
    pendingBatches.delete(responseId);
    if (batch.calls.size === 0 || closedByServer || closeRun) {
      return;
    }
    const calls = [...batch.calls.values()];
    const delegationDetail =
      batch.delegationId === undefined ? undefined : `delegation=${batch.delegationId}`;
    void Promise.all(calls.map((call) => runFunctionCall(call, batch.delegationId)))
      .then((outputs) => {
        if (closedByServer || closeRun) {
          return;
        }
        for (const [index, call] of calls.entries()) {
          sendOnChannel({
            type: "response.item.create",
            item: { type: "function_call_output", call_id: call.callId, output: outputs[index]! },
          });
        }
        if (batch.continuationSent) {
          return;
        }
        batch.continuationSent = true;
        sendOnChannel({ type: "response.create" });
        emitMark("function_call_output_sent", delegationDetail ?? `${calls.length} result(s)`);
      })
      .catch((cause: unknown) => {
        // runFunctionCall never rejects; this guards unexpected chain breaks.
        emit({
          type: "error",
          error: asVoiceToolError("invalid_request", `Function loop broke: ${String(cause)}`),
        });
      });
  };

  const batchFor = (responseId: string, delegationId: string | undefined) => {
    let batch = pendingBatches.get(responseId);
    if (batch === undefined) {
      batch = {
        delegationId,
        calls: new Map(),
        completed: false,
        continuationSent: false,
      };
      pendingBatches.set(responseId, batch);
    }
    return batch;
  };

  const innerPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
    const inner = payload.event;
    return inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : payload;
  };

  const responseIdOf = (payload: Record<string, unknown>): string | undefined => {
    if (typeof payload.response_id === "string") {
      return payload.response_id;
    }
    const response = payload.response;
    if (
      response !== null &&
      typeof response === "object" &&
      typeof (response as Record<string, unknown>).id === "string"
    ) {
      return (response as Record<string, unknown>).id as string;
    }
    return undefined;
  };

  /** Delegation events arrive nested in `response.event` envelopes carrying
      the outer `delegation_id`; top-level tool shapes are legacy and are not
      handled. Function results are collected from
      `response.output_item.done` and submitted when the response completes. */
  const handleDelegationEvent = (
    delegationId: string | undefined,
    payload: Record<string, unknown>,
  ) => {
    switch (payload.type) {
      case "response.created": {
        trackedResponseId = responseIdOf(payload) ?? trackedResponseId;
        if (trackedResponseId !== undefined) {
          batchFor(trackedResponseId, delegationId);
        }
        break;
      }
      case "response.output_item.done": {
        const item = toFunctionCallItem(payload.item);
        if (item === undefined) {
          break;
        }
        const responseId = responseIdOf(payload) ?? trackedResponseId;
        if (responseId === undefined) {
          break;
        }
        const batch = batchFor(responseId, delegationId);
        // Duplicate deliveries of the same call are recorded once.
        if (!batch.calls.has(item.callId)) {
          batch.calls.set(item.callId, item);
          emitMark("function_call_received", item.name);
        }
        break;
      }
      case "response.completed": {
        const responseId = responseIdOf(payload) ?? trackedResponseId;
        if (responseId !== undefined) {
          if (
            pendingBatches.get(responseId)?.calls.size === 0 &&
            (!navigationConfirmed || hasSubstantiveTools)
          ) {
            setSpeechSuppressed(false);
          }
          finalizeResponseBatch(responseId);
        }
        break;
      }
      default:
        break;
    }
  };

  const handleServerEvent = (event: LiveServerEvent) => {
    if (event.type === "response.event") {
      handleDelegationEvent(
        typeof event.payload.delegation_id === "string" ? event.payload.delegation_id : undefined,
        innerPayload(event.payload),
      );
      return;
    }
    switch (event.type) {
      case "error": {
        setSpeechSuppressed(false);
        const error = event.payload.error;
        if (
          error !== null &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ) {
          emit({ type: "error", error: { code: "invalid_request", message: error.message } });
        }
        break;
      }
      case "session.delegation.created":
        emitMark("session_delegation_created", "session.delegation.created");
        if (event.payload.delegation && typeof event.payload.delegation === "object") {
          const delegation = event.payload.delegation as Record<string, unknown>;
          if (typeof delegation.id === "string" && !creationByDelegation.has(delegation.id)) {
            navigationConfirmed = false;
            hasSubstantiveTools = false;
            creationByDelegation.set(delegation.id, allowsThreadCreation(inputTranscript));
            inputTranscript = "";
          }
          if (delegation.target === "client" && typeof delegation.id === "string") {
            emit({ type: "delegation", id: delegation.id });
          }
        }
        break;
      case "session.started":
        liveSeen = true;
        setState("live");
        break;
      case "session.input_transcript.delta": {
        const delta = event.payload.delta;
        if (typeof delta === "string") {
          inputTranscript += delta;
          if (/\p{L}/u.test(inputTranscript))
            setSpeechSuppressed(isUiCommandPrefix(inputTranscript));
          emit({ type: "transcript", channel: "input", delta });
        }
        break;
      }
      case "session.output_transcript.delta": {
        if (speechSuppressed) break;
        const delta = event.payload.delta;
        if (typeof delta === "string") {
          // Live owns turn detection; the annotated recorded-input endpoint
          // is the authoritative utterance-end baseline and the browser
          // cannot supply one yet, so this mark explicitly records absence.
          if (!firstOutputDeltaSeen) {
            firstOutputDeltaSeen = true;
            emitMark("utterance_end", "no annotated recorded-input endpoint", "unavailable");
            emitMark("first_output_transcript_delta");
          }
          emit({ type: "transcript", channel: "output", delta });
        }
        break;
      }
      case "session.usage.updated":
        reportUsage(event.payload.usage);
        break;
      case "session.closed":
        reportUsage(event.payload.usage);
        closedByServer = true;
        setState("closed");
        resolveClosedWaiter();
        break;
      default:
        break;
    }
  };

  const attachDataChannel = (channel: VoiceLiveRtcDataChannel) => {
    channel.onmessage = (event) => {
      const parsed = parseServerEvent(event.data);
      if (parsed !== undefined) {
        handleServerEvent(parsed);
      }
    };
    channel.onerror = (event) => {
      transportLost(event.message ?? "The oai-events data channel errored.");
    };
    channel.onclose = () => {
      if (state !== "closed" && state !== "error") {
        if (closedByServer) {
          resolveClosedWaiter();
        } else {
          transportLost("The oai-events data channel closed before session.closed.");
        }
      }
    };
  };

  const start = async (): Promise<{ readonly sessionId: VoiceSessionId }> => {
    if (state !== "idle" && state !== "error") {
      throw asVoiceToolError("invalid_request", "The voice session has already been started.");
    }
    setState("minting");
    const pc = options.createPeerConnection();
    peerConnection = pc;
    pc.ontrack = (event) => {
      emit({ type: "track", track: event.track });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        transportLost(`The peer connection ${pc.connectionState}.`);
      }
    };
    if (options.audioTrack !== undefined) {
      pc.addTrack(options.audioTrack);
    }

    const channel = pc.createDataChannel("oai-events");
    dataChannel = channel;
    attachDataChannel(channel);

    let offer: VoiceLiveSessionDescription;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (cause) {
      fail(
        asVoiceToolError(
          "environment_unreachable",
          cause instanceof Error ? cause.message : "Failed to create the WebRTC offer.",
        ),
      );
      throw asVoiceToolError("environment_unreachable", "Failed to create the WebRTC offer.");
    }

    let created: VoiceBrokerSessionCreated;
    try {
      created = await options.broker.mintSession({
        transport: { type: "webrtc", sdp: offer.sdp },
      });
    } catch (cause) {
      const error = toVoiceToolError(cause);
      fail(error);
      pc.close();
      throw error;
    }
    // Cancellation check: close() may have run (or the transport may have
    // died) while the mint was pending. The minted session still exists
    // upstream, so its broker accounting must settle — close() skipped it
    // because sessionId was still undefined — but the local session is never
    // established: no connecting state, no live transition, peer connection
    // released, and start() settles by rejecting.
    if (closeRun || closedByServer || readState() === "error") {
      sessionId = created.sessionId;
      try {
        await options.broker.closeSession({ sessionId });
      } catch (cause) {
        emit({ type: "error", error: toVoiceToolError(cause) });
      }
      pc.close();
      // Unblock a pending close() that is waiting for a session.closed that
      // will never come for a session that never started.
      resolveClosedWaiter();
      throw asVoiceToolError("invalid_request", "The voice session was closed before it started.");
    }
    sessionId = created.sessionId;
    setState("connecting");
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: created.sdp });
    } catch {
      const error = asVoiceToolError(
        "environment_unreachable",
        "The Live answer SDP was rejected by the peer connection.",
      );
      fail(error);
      throw error;
    }
    // Cancellation check again: close() may have landed during the connecting
    // phase. Broker accounting is already handled — sessionId was assigned
    // before close() could run — so only the local release and the settlement
    // remain.
    if (closeRun || closedByServer || readState() === "error") {
      pc.close();
      throw asVoiceToolError("invalid_request", "The voice session was closed before it started.");
    }

    if (!liveSeen) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onState = (event: VoiceLiveClientEvent) => {
          if (settled) {
            return;
          }
          if (event.type === "state" && event.state === "live") {
            settled = true;
            off();
            resolve();
          } else if (event.type === "error") {
            settled = true;
            off();
            reject(event.error);
          } else if (event.type === "state" && event.state === "closed") {
            // Closure during the startup wait always settles start(): the
            // session the caller asked for no longer exists, so the request
            // is refused with a frozen code instead of hanging forever.
            settled = true;
            off();
            reject(
              asVoiceToolError(
                "invalid_request",
                "The voice session was closed before it started.",
              ),
            );
          }
        };
        const off = onEvent(onState);
      });
    }
    return { sessionId: created.sessionId };
  };

  const toVoiceToolError = (cause: unknown): VoiceToolError => {
    if (
      typeof cause === "object" &&
      cause !== null &&
      typeof (cause as Record<string, unknown>).code === "string" &&
      typeof (cause as Record<string, unknown>).message === "string"
    ) {
      const record = cause as Record<string, unknown>;
      return asVoiceToolError(record.code as VoiceToolErrorCode, record.message as string);
    }
    return asVoiceToolError(
      "environment_unreachable",
      cause instanceof Error ? cause.message : "The broker rejected the session request.",
    );
  };

  const close = async (): Promise<void> => {
    if (closeRun || state === "idle") {
      return;
    }
    closeRun = true;
    if (!closedByServer && state !== "error") {
      setState("closing");
      // The channel may not be open yet (close during minting/connecting), in
      // which case the send throws; the transport teardown below still ends
      // the session locally, and the waiter is skipped like for a missing
      // channel.
      let sent = false;
      try {
        sent = sendOnChannel({ type: "session.close" });
      } catch {
        sent = false;
      }
      if (sent) {
        await new Promise<void>((resolve) => {
          closedWaiter = resolve;
        });
      }
    }
    if (sessionId !== undefined) {
      try {
        await options.broker.closeSession({ sessionId });
      } catch (cause) {
        // Revocation or disconnect between the media close and broker
        // accounting must not lose the local close.
        emit({ type: "error", error: toVoiceToolError(cause) });
      }
    }
    dataChannel?.close();
    peerConnection?.close();
    setSpeechSuppressed(false);
    setState("closed");
  };

  const onEvent = (listener: (event: VoiceLiveClientEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  let steerSequence = 0;
  const steer = (content: string): boolean => {
    const trimmed = content.trim();
    if (trimmed.length === 0 || state !== "live" || closedByServer) {
      return false;
    }
    steerSequence += 1;
    // Documented unsolicited steering shape: plain-string content, and
    // delegation_id is required even when null (never a delegation id).
    return sendOnChannel({
      type: "session.commentary.append",
      event_id: `voice_steering_${now()}_${steerSequence}`,
      delegation_id: null,
      content: trimmed,
    });
  };

  return {
    start,
    close,
    onEvent,
    emitMark: (mark, detail) => emitMark(mark, detail),
    steer,
    setSpeechSuppressed,
    sendText: (text) => {
      if (state !== "live" || closedByServer || !text.trim()) return false;
      inputTranscript = text;
      setSpeechSuppressed(isUiCommandPrefix(text));
      if (
        !sendOnChannel({
          type: "response.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        })
      )
        return false;
      return sendOnChannel({ type: "response.create" });
    },
    getState: () => state,
    getSessionId: () => sessionId,
  };
};

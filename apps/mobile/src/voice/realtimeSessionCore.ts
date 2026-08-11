import {
  RealtimeSessionError,
  serializeRealtimeSessionUpdate,
  serializeRealtimeToolOutputBatch,
  type RealtimeSessionAttempt,
  type RealtimeSessionErrorReason,
  type RealtimeToolOutputBatch,
  type RealtimeTransportConnectInput,
  type RealtimeTransportController,
  type RealtimeTransportState,
} from "@t3tools/client-runtime/voice/realtime-transport";
import type { VoiceRealtimeClientSecret } from "@t3tools/contracts";

import {
  decodeRealtimeServerEventMessage,
  extractRealtimeFunctionCalls,
} from "@t3tools/client-runtime/voice/realtime-events";

export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export const MOBILE_REALTIME_MEDIA_CONSTRAINTS = {
  audio: true,
  video: false,
} as const;

const MAX_REALTIME_SDP_CHARS = 1_000_000;
export const MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS = 20_000;

export type MobileVoiceAppState = "active" | "background" | "inactive" | "unknown" | "extension";
export type MobileVoiceAudioSessionEvent = "interruption" | "route_lost" | "media_services_reset";

export interface MobileRealtimeMediaTrack {
  readonly kind: string;
  enabled: boolean;
  stop: () => void;
}

export interface MobileRealtimeMediaStream {
  readonly getTracks: () => ReadonlyArray<MobileRealtimeMediaTrack>;
  readonly getAudioTracks: () => ReadonlyArray<MobileRealtimeMediaTrack>;
  readonly release?: (releaseTracks?: boolean) => void;
}

export interface MobileRealtimeDataChannelEvent {
  readonly data?: unknown;
}

export type MobileRealtimeDataChannelEventType = "open" | "message" | "error" | "close";

export interface MobileRealtimeDataChannel {
  readonly readyState: string;
  readonly addEventListener: (
    type: MobileRealtimeDataChannelEventType,
    listener: (event: MobileRealtimeDataChannelEvent) => void,
  ) => void;
  readonly removeEventListener: (
    type: MobileRealtimeDataChannelEventType,
    listener: (event: MobileRealtimeDataChannelEvent) => void,
  ) => void;
  readonly send: (data: string) => void;
  readonly close: () => void;
}

export interface MobileRealtimeTrackEvent {
  readonly track: MobileRealtimeMediaTrack | null;
  readonly streams: ReadonlyArray<MobileRealtimeMediaStream>;
}

export type MobileRealtimePeerEventType = "track" | "connectionstatechange";

export interface MobileRealtimePeerConnection {
  readonly connectionState: string;
  readonly createDataChannel: (label: string) => MobileRealtimeDataChannel;
  readonly addTrack: (
    track: MobileRealtimeMediaTrack,
    stream: MobileRealtimeMediaStream,
  ) => unknown;
  readonly createOffer: () => Promise<{ readonly type: "offer"; readonly sdp?: string }>;
  readonly setLocalDescription: (description: {
    readonly type: "offer";
    readonly sdp?: string;
  }) => Promise<void>;
  readonly setRemoteDescription: (description: {
    readonly type: "answer";
    readonly sdp: string;
  }) => Promise<void>;
  readonly addEventListener: (
    type: MobileRealtimePeerEventType,
    listener: (event: MobileRealtimeTrackEvent | undefined) => void,
  ) => void;
  readonly removeEventListener: (
    type: MobileRealtimePeerEventType,
    listener: (event: MobileRealtimeTrackEvent | undefined) => void,
  ) => void;
  readonly getSenders?: () => ReadonlyArray<{
    readonly track: MobileRealtimeMediaTrack | null;
  }>;
  readonly getReceivers?: () => ReadonlyArray<{
    readonly track: MobileRealtimeMediaTrack | null;
  }>;
  readonly close: () => void;
}

export interface MobileRealtimeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}

export interface MobileRealtimeFetchInit {
  readonly method: "POST";
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface MobileVoiceAudioSessionLease {
  readonly stop: () => void;
}

export interface MobileVoiceAudioSession {
  readonly start: (
    listener: (event: MobileVoiceAudioSessionEvent) => void,
  ) => MobileVoiceAudioSessionLease;
}

type MobileRealtimeTimer = ReturnType<typeof setTimeout>;

export interface MobileRealtimeSessionDependencies {
  readonly getAppState: () => MobileVoiceAppState;
  readonly subscribeToAppState: (listener: (state: MobileVoiceAppState) => void) => () => void;
  readonly requestMicrophonePermission: () => Promise<boolean>;
  readonly getUserMedia: (
    constraints: typeof MOBILE_REALTIME_MEDIA_CONSTRAINTS,
  ) => Promise<MobileRealtimeMediaStream>;
  readonly createPeerConnection: () => MobileRealtimePeerConnection;
  readonly audioSession: MobileVoiceAudioSession;
  readonly fetch: (url: string, init: MobileRealtimeFetchInit) => Promise<MobileRealtimeResponse>;
  readonly nowEpochMs: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => MobileRealtimeTimer;
  readonly cancelScheduled: (handle: MobileRealtimeTimer) => void;
}

type ChannelState = "pending" | "open" | "failed";
type PermissionPhase = "preflight" | "requesting" | "awaiting_active" | "complete";

interface SessionAttemptState extends RealtimeTransportConnectInput {
  readonly generation: number;
  readonly abortController: AbortController;
  readonly channelStatePromise: Promise<void>;
  readonly resolveChannelState: () => void;
  readonly removeEventListeners: Array<() => void>;
  readonly remoteTracks: Set<MobileRealtimeMediaTrack>;
  readonly appStateWaiters: Set<() => void>;
  channelState: ChannelState;
  peerConnection: MobileRealtimePeerConnection | undefined;
  dataChannel: MobileRealtimeDataChannel | undefined;
  localStream: MobileRealtimeMediaStream | undefined;
  muted: boolean;
  appState: MobileVoiceAppState;
  permissionPhase: PermissionPhase;
  audioSessionLease: MobileVoiceAudioSessionLease | undefined;
  connected: boolean;
  cleanedUp: boolean;
  terminalError: RealtimeSessionError | undefined;
  negotiationTimer: MobileRealtimeTimer | undefined;
}

function makeAttemptState(
  generation: number,
  input: RealtimeTransportConnectInput,
): SessionAttemptState {
  let resolveChannelState = () => {};
  const channelStatePromise = new Promise<void>((resolve) => {
    resolveChannelState = resolve;
  });
  return {
    ...input,
    generation,
    abortController: new AbortController(),
    channelStatePromise,
    resolveChannelState,
    removeEventListeners: [],
    remoteTracks: new Set(),
    appStateWaiters: new Set(),
    channelState: "pending",
    peerConnection: undefined,
    dataChannel: undefined,
    localStream: undefined,
    muted: false,
    appState: "unknown",
    permissionPhase: "preflight",
    audioSessionLease: undefined,
    connected: false,
    cleanedUp: false,
    terminalError: undefined,
    negotiationTimer: undefined,
  };
}

function safeCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Consumer callbacks cannot own or break the native transport lifecycle.
  }
}

function stopTrack(track: MobileRealtimeMediaTrack): void {
  try {
    track.stop();
  } catch {
    // Native tracks can already be released during peer teardown.
  }
}

function safeStreamTracks(
  stream: MobileRealtimeMediaStream,
): ReadonlyArray<MobileRealtimeMediaTrack> {
  try {
    return stream.getTracks();
  } catch {
    return [];
  }
}

function stopAndReleaseStream(stream: MobileRealtimeMediaStream): void {
  for (const track of safeStreamTracks(stream)) stopTrack(track);
  try {
    stream.release?.(true);
  } catch {
    // Releasing the stream must not block the rest of teardown.
  }
}

function settleChannelState(attempt: SessionAttemptState, state: Exclude<ChannelState, "pending">) {
  if (attempt.channelState !== "pending") return;
  attempt.channelState = state;
  attempt.resolveChannelState();
}

function peerConnectionIsTerminal(peerConnection: MobileRealtimePeerConnection): boolean {
  return peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed";
}

function normalizeStageError(
  attempt: SessionAttemptState,
  reason: RealtimeSessionErrorReason,
  error: unknown,
): RealtimeSessionError {
  if (attempt.terminalError) return attempt.terminalError;
  if (attempt.abortController.signal.aborted) return new RealtimeSessionError("aborted");
  if (error instanceof RealtimeSessionError) return error;
  return new RealtimeSessionError(reason);
}

function awaitAttemptStage<T>(
  attempt: SessionAttemptState,
  operation: () => T | PromiseLike<T>,
  reason: RealtimeSessionErrorReason,
  isOwned: () => boolean,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const signal = attempt.abortController.signal;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(attempt.terminalError ?? new RealtimeSessionError("aborted")));

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    void Promise.resolve().then(() => {
      if (settled) return;
      if (!isOwned()) {
        finish(() => reject(attempt.terminalError ?? new RealtimeSessionError("aborted")));
        return;
      }

      let result: T | PromiseLike<T>;
      try {
        result = operation();
      } catch (error) {
        finish(() => reject(normalizeStageError(attempt, reason, error)));
        return;
      }
      void Promise.resolve(result).then(
        (value) => {
          if (settled || !isOwned()) {
            try {
              onLateValue?.(value);
            } catch {
              // Late native cleanup cannot mutate the active generation.
            }
            if (!settled) {
              finish(() => reject(attempt.terminalError ?? new RealtimeSessionError("aborted")));
            }
            return;
          }
          finish(() => resolve(value));
        },
        (error: unknown) => {
          if (settled) return;
          finish(() => reject(normalizeStageError(attempt, reason, error)));
        },
      );
    });
  });
}

function validateClientSecret(
  value: VoiceRealtimeClientSecret,
  nowEpochMs: number,
): VoiceRealtimeClientSecret {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.clientSecret !== "string" ||
    value.clientSecret.trim().length === 0 ||
    value.clientSecret.length > 4_096 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0
  ) {
    throw new RealtimeSessionError("client_secret_failed");
  }
  if (value.expiresAt * 1_000 <= nowEpochMs) {
    throw new RealtimeSessionError("client_secret_expired");
  }
  return value;
}

/** Owns one foreground-only native Realtime WebRTC attempt at a time. */
export function createMobileRealtimeSessionControllerCore(
  dependencies: MobileRealtimeSessionDependencies,
): RealtimeTransportController {
  let nextGeneration = 0;
  let current: SessionAttemptState | undefined;

  const isOwned = (attempt: SessionAttemptState) =>
    current === attempt && !attempt.abortController.signal.aborted && !attempt.cleanedUp;

  const notifyTransport = (
    attempt: SessionAttemptState,
    state: RealtimeTransportState,
    error?: RealtimeSessionError,
  ) => {
    safeCallback(() =>
      attempt.onTransportState?.(
        error === undefined
          ? { generation: attempt.generation, state }
          : { generation: attempt.generation, state, error },
      ),
    );
  };

  const cleanup = (attempt: SessionAttemptState) => {
    if (attempt.cleanedUp) return;
    attempt.cleanedUp = true;
    if (attempt.negotiationTimer !== undefined) {
      dependencies.cancelScheduled(attempt.negotiationTimer);
      attempt.negotiationTimer = undefined;
    }
    attempt.abortController.abort();
    settleChannelState(attempt, "failed");
    for (const wake of attempt.appStateWaiters) wake();
    attempt.appStateWaiters.clear();

    for (const removeEventListener of attempt.removeEventListeners.splice(0)) {
      try {
        removeEventListener();
      } catch {
        // Native listener removal is best-effort after module destruction.
      }
    }

    const peerConnection = attempt.peerConnection;
    const tracks = new Set(attempt.remoteTracks);
    if (attempt.localStream) {
      for (const track of safeStreamTracks(attempt.localStream)) tracks.add(track);
    }
    try {
      for (const sender of peerConnection?.getSenders?.() ?? []) {
        if (sender.track) tracks.add(sender.track);
      }
    } catch {
      // A failed native peer can reject sender inspection during teardown.
    }
    try {
      for (const receiver of peerConnection?.getReceivers?.() ?? []) {
        if (receiver.track) tracks.add(receiver.track);
      }
    } catch {
      // A failed native peer can reject receiver inspection during teardown.
    }
    for (const track of tracks) stopTrack(track);

    if (attempt.localStream !== undefined) {
      try {
        attempt.localStream.release?.(true);
      } catch {
        // Stream release must not block channel, peer, or audio-focus teardown.
      }
    }
    try {
      attempt.dataChannel?.close();
    } catch {
      // Closing an already-closed data channel is harmless.
    }
    try {
      peerConnection?.close();
    } catch {
      // Closing an already-closed peer is harmless.
    }
    if (attempt.audioSessionLease) {
      const lease = attempt.audioSessionLease;
      attempt.audioSessionLease = undefined;
      try {
        lease.stop();
      } catch {
        // The native module still owns its own module-destruction cleanup.
      }
    }
  };

  const terminate = (
    attempt: SessionAttemptState,
    state: Extract<RealtimeTransportState, "disconnected" | "failed" | "closed">,
    error?: RealtimeSessionError,
  ) => {
    if (!isOwned(attempt)) return;
    current = undefined;
    cleanup(attempt);
    notifyTransport(attempt, state, error);
  };

  const failBeforeReady = (attempt: SessionAttemptState, error: RealtimeSessionError) => {
    if (!isOwned(attempt) || attempt.connected || attempt.terminalError) return;
    attempt.terminalError = error;
    attempt.abortController.abort();
    settleChannelState(attempt, "failed");
  };

  const attachRemoteTracks = (attempt: SessionAttemptState, event: MobileRealtimeTrackEvent) => {
    const tracks = new Set<MobileRealtimeMediaTrack>();
    if (event.track) tracks.add(event.track);
    for (const stream of event.streams) {
      for (const track of safeStreamTracks(stream)) tracks.add(track);
    }
    for (const track of tracks) {
      if (!isOwned(attempt) || track.kind !== "audio") {
        stopTrack(track);
      } else {
        attempt.remoteTracks.add(track);
      }
    }
  };

  const attachDataChannel = (attempt: SessionAttemptState, channel: MobileRealtimeDataChannel) => {
    const onOpen = () => {
      if (isOwned(attempt)) settleChannelState(attempt, "open");
    };
    const onMessage = (message: MobileRealtimeDataChannelEvent) => {
      if (!isOwned(attempt)) return;
      const event = decodeRealtimeServerEventMessage(message.data);
      if (!event) return;
      safeCallback(() => attempt.onServerEvent?.({ generation: attempt.generation, event }));
      if (!isOwned(attempt)) return;
      const calls = extractRealtimeFunctionCalls(event);
      if (calls.length > 0) {
        safeCallback(() => attempt.onFunctionCalls?.({ generation: attempt.generation, calls }));
      }
    };
    const onError = () => {
      if (!isOwned(attempt)) return;
      if (!attempt.connected) {
        failBeforeReady(attempt, new RealtimeSessionError("data_channel_failed"));
      } else {
        terminate(attempt, "failed", new RealtimeSessionError("data_channel_failed"));
      }
    };
    const onClose = () => {
      if (!isOwned(attempt)) return;
      if (!attempt.connected) {
        failBeforeReady(attempt, new RealtimeSessionError("data_channel_failed"));
      } else {
        terminate(attempt, "closed");
      }
    };
    channel.addEventListener("open", onOpen);
    attempt.removeEventListeners.push(() => channel.removeEventListener("open", onOpen));
    channel.addEventListener("message", onMessage);
    attempt.removeEventListeners.push(() => channel.removeEventListener("message", onMessage));
    channel.addEventListener("error", onError);
    attempt.removeEventListeners.push(() => channel.removeEventListener("error", onError));
    channel.addEventListener("close", onClose);
    attempt.removeEventListeners.push(() => channel.removeEventListener("close", onClose));
    if (channel.readyState === "open") {
      settleChannelState(attempt, "open");
    } else if (channel.readyState === "closing" || channel.readyState === "closed") {
      failBeforeReady(attempt, new RealtimeSessionError("data_channel_failed"));
    }
  };

  const attachLifecycle = (attempt: SessionAttemptState): boolean => {
    const removeAppState = dependencies.subscribeToAppState((state) => {
      if (!isOwned(attempt)) return;
      attempt.appState = state;
      for (const wake of attempt.appStateWaiters) wake();
      attempt.appStateWaiters.clear();
      if (state === "active") return;
      // The first iOS permission sheet can make an otherwise foreground app
      // temporarily inactive. Backgrounding still cancels permission outright.
      if (
        state === "inactive" &&
        (attempt.permissionPhase === "requesting" || attempt.permissionPhase === "awaiting_active")
      ) {
        return;
      }
      terminate(attempt, "closed");
    });
    if (!isOwned(attempt)) {
      safeCallback(removeAppState);
      return false;
    }
    attempt.removeEventListeners.push(removeAppState);
    return true;
  };

  const waitForPermissionPromptToReturn = async (attempt: SessionAttemptState) => {
    attempt.permissionPhase = "awaiting_active";
    attempt.appState = dependencies.getAppState();
    while (isOwned(attempt) && attempt.appState !== "active") {
      if (attempt.appState !== "inactive") {
        terminate(attempt, "closed");
        throw new RealtimeSessionError("aborted");
      }
      await awaitAttemptStage(
        attempt,
        () =>
          new Promise<void>((resolve) => {
            attempt.appStateWaiters.add(resolve);
            if (attempt.appState === "active") {
              attempt.appStateWaiters.delete(resolve);
              resolve();
            }
          }),
        "connection_failed",
        () => isOwned(attempt),
      );
    }
    if (!isOwned(attempt)) throw new RealtimeSessionError("aborted");
    attempt.permissionPhase = "complete";
  };

  const start = async (attempt: SessionAttemptState) => {
    if (!isOwned(attempt)) throw new RealtimeSessionError("aborted");
    const initialAppState = dependencies.getAppState();
    if (!isOwned(attempt)) throw new RealtimeSessionError("aborted");
    if (initialAppState !== "active") {
      throw new RealtimeSessionError("connection_failed");
    }
    if (!attachLifecycle(attempt)) throw new RealtimeSessionError("aborted");
    attempt.appState = dependencies.getAppState();
    if (attempt.appState !== "active" || !isOwned(attempt)) {
      throw new RealtimeSessionError("aborted");
    }

    const permissionGranted = await awaitAttemptStage(
      attempt,
      () => {
        attempt.permissionPhase = "requesting";
        return dependencies.requestMicrophonePermission();
      },
      "microphone_access_failed",
      () => isOwned(attempt),
    );
    if (!permissionGranted) throw new RealtimeSessionError("microphone_access_failed");
    await waitForPermissionPromptToReturn(attempt);

    let audioSessionLease: MobileVoiceAudioSessionLease;
    try {
      audioSessionLease = dependencies.audioSession.start(() => {
        if (isOwned(attempt)) terminate(attempt, "closed");
      });
    } catch {
      throw new RealtimeSessionError("connection_failed");
    }
    if (!isOwned(attempt)) {
      safeCallback(() => audioSessionLease.stop());
      throw new RealtimeSessionError("aborted");
    }
    attempt.audioSessionLease = audioSessionLease;

    const stream = await awaitAttemptStage(
      attempt,
      () => dependencies.getUserMedia(MOBILE_REALTIME_MEDIA_CONSTRAINTS),
      "microphone_access_failed",
      () => isOwned(attempt),
      stopAndReleaseStream,
    );
    if (!isOwned(attempt)) {
      stopAndReleaseStream(stream);
      throw attempt.terminalError ?? new RealtimeSessionError("aborted");
    }
    attempt.localStream = stream;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) throw new RealtimeSessionError("microphone_access_failed");
    for (const track of audioTracks) track.enabled = !attempt.muted;

    attempt.negotiationTimer = dependencies.schedule(() => {
      attempt.negotiationTimer = undefined;
      failBeforeReady(attempt, new RealtimeSessionError("negotiation_timeout"));
    }, MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS);

    let peerConnection: MobileRealtimePeerConnection;
    let dataChannel: MobileRealtimeDataChannel;
    try {
      peerConnection = dependencies.createPeerConnection();
      attempt.peerConnection = peerConnection;
      if (peerConnectionIsTerminal(peerConnection)) {
        const error = new RealtimeSessionError("connection_failed");
        failBeforeReady(attempt, error);
        throw error;
      }
      dataChannel = peerConnection.createDataChannel("oai-events");
      attempt.dataChannel = dataChannel;
      const onTrack = (event: MobileRealtimeTrackEvent | undefined) => {
        if (event) attachRemoteTracks(attempt, event);
      };
      const onConnectionStateChange = () => {
        if (!isOwned(attempt)) return;
        if (
          peerConnection.connectionState === "failed" ||
          peerConnection.connectionState === "closed"
        ) {
          if (attempt.connected) {
            terminate(
              attempt,
              peerConnection.connectionState === "failed" ? "failed" : "closed",
              peerConnection.connectionState === "failed"
                ? new RealtimeSessionError("connection_failed")
                : undefined,
            );
          } else {
            failBeforeReady(attempt, new RealtimeSessionError("connection_failed"));
          }
        } else if (attempt.connected && peerConnection.connectionState === "disconnected") {
          notifyTransport(attempt, "disconnected");
        }
      };
      peerConnection.addEventListener("track", onTrack);
      attempt.removeEventListeners.push(() => peerConnection.removeEventListener("track", onTrack));
      peerConnection.addEventListener("connectionstatechange", onConnectionStateChange);
      attempt.removeEventListeners.push(() =>
        peerConnection.removeEventListener("connectionstatechange", onConnectionStateChange),
      );
      attachDataChannel(attempt, dataChannel);
      if (attempt.terminalError) throw attempt.terminalError;
      for (const track of audioTracks) peerConnection.addTrack(track, stream);
    } catch (error) {
      if (error instanceof RealtimeSessionError) throw error;
      throw new RealtimeSessionError("negotiation_failed");
    }

    const offer = await awaitAttemptStage(
      attempt,
      () => peerConnection.createOffer(),
      "negotiation_failed",
      () => isOwned(attempt),
    );
    const offerSdp = offer.sdp;
    if (
      typeof offerSdp !== "string" ||
      offerSdp.length === 0 ||
      offerSdp.length > MAX_REALTIME_SDP_CHARS
    ) {
      throw new RealtimeSessionError("negotiation_failed");
    }
    await awaitAttemptStage(
      attempt,
      () => peerConnection.setLocalDescription(offer),
      "negotiation_failed",
      () => isOwned(attempt),
    );

    const clientSecret = validateClientSecret(
      await awaitAttemptStage(
        attempt,
        () => attempt.getClientSecret(attempt.abortController.signal),
        "client_secret_failed",
        () => isOwned(attempt),
      ),
      dependencies.nowEpochMs(),
    );

    const response = await awaitAttemptStage(
      attempt,
      () =>
        dependencies.fetch(OPENAI_REALTIME_CALLS_URL, {
          method: "POST",
          body: offerSdp,
          headers: {
            Authorization: `Bearer ${clientSecret.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          signal: attempt.abortController.signal,
        }),
      "negotiation_failed",
      () => isOwned(attempt),
    );
    if (!response.ok) throw new RealtimeSessionError("upstream_rejected", response.status);
    const answerSdp = await awaitAttemptStage(
      attempt,
      () => response.text(),
      "negotiation_failed",
      () => isOwned(attempt),
    );
    if (answerSdp.length === 0 || answerSdp.length > MAX_REALTIME_SDP_CHARS) {
      throw new RealtimeSessionError("negotiation_failed");
    }
    await awaitAttemptStage(
      attempt,
      () => peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp }),
      "negotiation_failed",
      () => isOwned(attempt),
    );
    await awaitAttemptStage(
      attempt,
      () => attempt.channelStatePromise,
      "data_channel_failed",
      () => isOwned(attempt),
    );
    if (attempt.channelState !== "open" || dataChannel.readyState !== "open") {
      throw new RealtimeSessionError("data_channel_failed");
    }
    if (attempt.terminalError || peerConnectionIsTerminal(peerConnection)) {
      throw attempt.terminalError ?? new RealtimeSessionError("connection_failed");
    }

    if (attempt.negotiationTimer !== undefined) {
      dependencies.cancelScheduled(attempt.negotiationTimer);
      attempt.negotiationTimer = undefined;
    }
    attempt.connected = true;
  };

  const connect = (input: RealtimeTransportConnectInput): RealtimeSessionAttempt => {
    const previous = current;
    if (previous) {
      current = undefined;
      cleanup(previous);
      notifyTransport(previous, "closed");
    }

    const attempt = makeAttemptState(++nextGeneration, input);
    current = attempt;
    notifyTransport(attempt, "connecting");
    const ready = start(attempt).then(
      () => {
        if (!isOwned(attempt)) throw new RealtimeSessionError("aborted");
        notifyTransport(attempt, "connected");
      },
      (error: unknown) => {
        const safeError = normalizeStageError(attempt, "connection_failed", error);
        const owned = current === attempt;
        if (owned) current = undefined;
        cleanup(attempt);
        if (owned && safeError.reason !== "aborted") notifyTransport(attempt, "failed", safeError);
        throw safeError;
      },
    );
    void ready.catch(() => undefined);
    return { generation: attempt.generation, ready };
  };

  const requireReadyChannel = () => {
    const attempt = current;
    if (!attempt || !attempt.connected || attempt.dataChannel?.readyState !== "open") {
      throw new RealtimeSessionError("not_ready");
    }
    return attempt.dataChannel;
  };

  const sendEncodedEvent = (channel: MobileRealtimeDataChannel, encoded: string) => {
    try {
      channel.send(encoded);
    } catch {
      throw new RealtimeSessionError("data_channel_failed");
    }
  };

  return {
    connect,
    setMuted: (muted) => {
      const attempt = current;
      if (!attempt) throw new RealtimeSessionError("not_ready");
      attempt.muted = muted;
      try {
        for (const track of attempt.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
      } catch {
        const error = new RealtimeSessionError("connection_failed");
        terminate(attempt, "failed", error);
        throw error;
      }
    },
    sendSessionUpdate: (session) => {
      const channel = requireReadyChannel();
      sendEncodedEvent(channel, serializeRealtimeSessionUpdate(session));
    },
    sendToolOutputs: (batch: RealtimeToolOutputBatch) => {
      const encoded = serializeRealtimeToolOutputBatch(batch);
      if (encoded.length === 0) return;
      const channel = requireReadyChannel();
      for (const event of encoded) sendEncodedEvent(channel, event);
    },
    dispose: () => {
      const attempt = current;
      current = undefined;
      if (!attempt) return;
      cleanup(attempt);
      notifyTransport(attempt, "closed");
    },
  };
}

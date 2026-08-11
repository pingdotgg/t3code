import type { VoiceRealtimeClientSecret } from "@t3tools/contracts";
import {
  decodeRealtimeServerEventMessage,
  extractRealtimeFunctionCalls,
} from "@t3tools/client-runtime/voice/realtime-events";
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

export * from "@t3tools/client-runtime/voice/realtime-transport";

export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export const REALTIME_MEDIA_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
} as const satisfies MediaStreamConstraints;

const MAX_REALTIME_SDP_CHARS = 1_000_000;
export const REALTIME_NEGOTIATION_TIMEOUT_MS = 20_000;

type RealtimeSessionTimer = ReturnType<typeof setTimeout>;

export interface RealtimeSessionConnectInput extends RealtimeTransportConnectInput {
  readonly audioElement: HTMLAudioElement;
}

export interface RealtimeSessionController extends Omit<RealtimeTransportController, "connect"> {
  readonly connect: (input: RealtimeSessionConnectInput) => RealtimeSessionAttempt;
}

export interface RealtimeSessionDependencies {
  readonly isSecureContext: () => boolean;
  readonly getMediaDevices: () => Pick<MediaDevices, "getUserMedia"> | undefined;
  readonly createPeerConnection: () => RTCPeerConnection;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly nowEpochMs: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => RealtimeSessionTimer;
  readonly cancelScheduled: (handle: RealtimeSessionTimer) => void;
}

type ChannelState = "pending" | "open" | "failed";

interface SessionAttemptState extends RealtimeSessionConnectInput {
  readonly generation: number;
  readonly abortController: AbortController;
  readonly channelStatePromise: Promise<void>;
  readonly resolveChannelState: () => void;
  channelState: ChannelState;
  peerConnection: RTCPeerConnection | undefined;
  dataChannel: RTCDataChannel | undefined;
  localStream: MediaStream | undefined;
  assignedRemoteStream: MediaStream | undefined;
  readonly remoteTracks: Set<MediaStreamTrack>;
  readonly removeEventListeners: Array<() => void>;
  muted: boolean;
  connected: boolean;
  cleanedUp: boolean;
  terminalError: RealtimeSessionError | undefined;
  negotiationTimer: RealtimeSessionTimer | undefined;
}

const defaultDependencies: RealtimeSessionDependencies = {
  isSecureContext: () => globalThis.isSecureContext === true,
  getMediaDevices: () => globalThis.navigator?.mediaDevices,
  createPeerConnection: () => new globalThis.RTCPeerConnection(),
  fetch: (input, init) => globalThis.fetch(input, init),
  nowEpochMs: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelScheduled: (handle) => clearTimeout(handle),
};

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function peerConnectionIsTerminal(peerConnection: RTCPeerConnection): boolean {
  return peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed";
}

function safeCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Consumer callbacks cannot own or break the transport lifecycle.
  }
}

function makeAttemptState(
  generation: number,
  input: RealtimeSessionConnectInput,
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
    channelState: "pending",
    peerConnection: undefined,
    dataChannel: undefined,
    localStream: undefined,
    assignedRemoteStream: undefined,
    remoteTracks: new Set(),
    removeEventListeners: [],
    muted: false,
    connected: false,
    cleanedUp: false,
    terminalError: undefined,
    negotiationTimer: undefined,
  };
}

function settleChannelState(attempt: SessionAttemptState, state: Exclude<ChannelState, "pending">) {
  if (attempt.channelState !== "pending") return;
  attempt.channelState = state;
  attempt.resolveChannelState();
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
    if (signal.aborted) {
      onAbort();
    }

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
          if (settled) {
            try {
              onLateValue?.(value);
            } catch {
              // Late cleanup cannot mutate the active generation.
            }
            return;
          }
          if (!isOwned()) {
            try {
              onLateValue?.(value);
            } catch {
              // Late cleanup cannot mutate the active generation.
            }
            finish(() => reject(attempt.terminalError ?? new RealtimeSessionError("aborted")));
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

/**
 * Owns one browser Realtime WebRTC transport at a time. Reconnect policy stays
 * above this primitive so retry budgets remain visible to the UI/controller.
 */
export function createRealtimeSessionController(
  dependencyOverrides: Partial<RealtimeSessionDependencies> = {},
): RealtimeSessionController {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
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

    for (const removeEventListener of attempt.removeEventListeners.splice(0)) {
      try {
        removeEventListener();
      } catch {
        // A browser object may already be torn down; continue releasing resources.
      }
    }
    const channel = attempt.dataChannel;
    const peerConnection = attempt.peerConnection;

    const tracks = new Set<MediaStreamTrack>(attempt.remoteTracks);
    for (const track of attempt.localStream?.getTracks() ?? []) tracks.add(track);
    for (const sender of peerConnection?.getSenders() ?? []) {
      if (sender.track) tracks.add(sender.track);
    }
    for (const receiver of peerConnection?.getReceivers() ?? []) {
      if (receiver.track) tracks.add(receiver.track);
    }
    for (const track of tracks) track.stop();

    if (
      attempt.assignedRemoteStream !== undefined &&
      attempt.audioElement.srcObject === attempt.assignedRemoteStream
    ) {
      try {
        attempt.audioElement.pause();
        attempt.audioElement.srcObject = null;
        attempt.audioElement.removeAttribute("src");
        attempt.audioElement.load();
      } catch {
        // DOM teardown must not prevent the remaining transport cleanup.
      }
    }

    try {
      channel?.close();
    } catch {
      // Closing an already-closed browser channel is harmless.
    }
    try {
      peerConnection?.close();
    } catch {
      // Closing an already-closed peer is harmless.
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

  const attachRemoteStream = (attempt: SessionAttemptState, event: RTCTrackEvent) => {
    const eventTracks = new Set<MediaStreamTrack>([event.track]);
    for (const stream of event.streams) {
      for (const track of stream.getTracks()) eventTracks.add(track);
    }
    for (const track of eventTracks) attempt.remoteTracks.add(track);
    if (!isOwned(attempt)) {
      for (const track of eventTracks) track.stop();
      return;
    }

    const stream = event.streams[0];
    if (!stream) return;
    attempt.assignedRemoteStream = stream;
    attempt.audioElement.srcObject = stream;
    const failPlayback = () => {
      const error = new RealtimeSessionError("audio_playback_failed");
      if (!isOwned(attempt)) return;
      if (attempt.connected) {
        terminate(attempt, "failed", error);
      } else {
        failBeforeReady(attempt, error);
      }
    };
    try {
      const playResult = attempt.audioElement.play();
      void playResult.catch(failPlayback);
    } catch {
      failPlayback();
    }
  };

  const attachDataChannel = (attempt: SessionAttemptState, channel: RTCDataChannel) => {
    const onOpen = () => {
      if (!isOwned(attempt)) return;
      settleChannelState(attempt, "open");
    };
    const onMessage = (message: MessageEvent<unknown>) => {
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
        return;
      }
      terminate(attempt, "failed", new RealtimeSessionError("data_channel_failed"));
    };
    const onClose = () => {
      if (!isOwned(attempt)) return;
      if (!attempt.connected) {
        failBeforeReady(attempt, new RealtimeSessionError("data_channel_failed"));
        return;
      }
      terminate(attempt, "closed");
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

  const start = async (attempt: SessionAttemptState) => {
    if (!dependencies.isSecureContext()) {
      throw new RealtimeSessionError("insecure_context");
    }
    const mediaDevices = dependencies.getMediaDevices();
    if (!mediaDevices?.getUserMedia) {
      throw new RealtimeSessionError("media_devices_unavailable");
    }

    const stream = await awaitAttemptStage(
      attempt,
      () => mediaDevices.getUserMedia(REALTIME_MEDIA_CONSTRAINTS),
      "microphone_access_failed",
      () => isOwned(attempt),
      stopTracks,
    );
    if (!isOwned(attempt)) {
      stopTracks(stream);
      throw attempt.terminalError ?? new RealtimeSessionError("aborted");
    }
    attempt.localStream = stream;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new RealtimeSessionError("microphone_access_failed");
    }
    for (const track of audioTracks) track.enabled = !attempt.muted;
    attempt.negotiationTimer = dependencies.schedule(() => {
      attempt.negotiationTimer = undefined;
      failBeforeReady(attempt, new RealtimeSessionError("negotiation_timeout"));
    }, REALTIME_NEGOTIATION_TIMEOUT_MS);

    let peerConnection: RTCPeerConnection;
    let dataChannel: RTCDataChannel;
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
      const onTrack = (event: RTCTrackEvent) => attachRemoteStream(attempt, event);
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
    } catch {
      throw new RealtimeSessionError("negotiation_failed");
    }

    const offer = await awaitAttemptStage(
      attempt,
      () => peerConnection.createOffer(),
      "negotiation_failed",
      () => isOwned(attempt),
    );
    const offerSdp = offer.sdp;
    if (typeof offerSdp !== "string" || offerSdp.length === 0) {
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
    if (!response.ok) {
      throw new RealtimeSessionError("upstream_rejected", response.status);
    }
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

  const connect = (input: RealtimeSessionConnectInput): RealtimeSessionAttempt => {
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
        if (owned && safeError.reason !== "aborted") {
          notifyTransport(attempt, "failed", safeError);
        }
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

  const sendEncodedEvent = (channel: RTCDataChannel, encoded: string) => {
    try {
      channel.send(encoded);
    } catch {
      throw new RealtimeSessionError("data_channel_failed");
    }
  };

  const sendToolOutputs = (batch: RealtimeToolOutputBatch) => {
    const encoded = serializeRealtimeToolOutputBatch(batch);
    if (encoded.length === 0) return;
    const channel = requireReadyChannel();
    for (const event of encoded) {
      sendEncodedEvent(channel, event);
    }
  };

  return {
    connect,
    setMuted: (muted) => {
      const attempt = current;
      if (!attempt) throw new RealtimeSessionError("not_ready");
      attempt.muted = muted;
      for (const track of attempt.localStream?.getAudioTracks() ?? []) {
        track.enabled = !muted;
      }
    },
    sendSessionUpdate: (session) => {
      const channel = requireReadyChannel();
      sendEncodedEvent(channel, serializeRealtimeSessionUpdate(session));
    },
    sendToolOutputs,
    dispose: () => {
      const attempt = current;
      current = undefined;
      if (!attempt) return;
      cleanup(attempt);
      notifyTransport(attempt, "closed");
    },
  };
}

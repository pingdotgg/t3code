import type {
  RealtimeFunctionCallEnvelope,
  RealtimeServerEventEnvelope,
  RealtimeTransportConnectInput,
  RealtimeTransportStateEnvelope,
} from "@t3tools/client-runtime/voice/realtime-transport";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MOBILE_REALTIME_MEDIA_CONSTRAINTS,
  MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS,
  OPENAI_REALTIME_CALLS_URL,
  createMobileRealtimeSessionControllerCore,
  type MobileRealtimeDataChannel,
  type MobileRealtimeDataChannelEvent,
  type MobileRealtimeDataChannelEventType,
  type MobileRealtimeMediaStream,
  type MobileRealtimeMediaTrack,
  type MobileRealtimePeerConnection,
  type MobileRealtimePeerEventType,
  type MobileRealtimeResponse,
  type MobileRealtimeSessionDependencies,
  type MobileRealtimeTrackEvent,
  type MobileVoiceAppState,
  type MobileVoiceAudioSessionEvent,
} from "./realtimeSessionCore";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeTrack implements MobileRealtimeMediaTrack {
  enabled = true;
  readonly stop = vi.fn();

  constructor(readonly kind = "audio") {}
}

class FakeStream implements MobileRealtimeMediaStream {
  readonly release = vi.fn();

  constructor(private readonly tracks: ReadonlyArray<FakeTrack>) {}

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

type DataChannelListener = (event: MobileRealtimeDataChannelEvent) => void;

class FakeDataChannel implements MobileRealtimeDataChannel {
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = "closed";
  });
  private readonly listeners = new Map<
    MobileRealtimeDataChannelEventType,
    Set<DataChannelListener>
  >();

  constructor(
    public readyState: string = "open",
    private readonly sendError?: unknown,
  ) {}

  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(data);
  }

  addEventListener(type: MobileRealtimeDataChannelEventType, listener: DataChannelListener): void {
    const listeners = this.listeners.get(type) ?? new Set<DataChannelListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: MobileRealtimeDataChannelEventType,
    listener: DataChannelListener,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: MobileRealtimeDataChannelEventType, event: MobileRealtimeDataChannelEvent = {}): void {
    if (type === "open") this.readyState = "open";
    if (type === "close") this.readyState = "closed";
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  retainedMessageListeners(): ReadonlyArray<DataChannelListener> {
    return [...(this.listeners.get("message") ?? [])];
  }
}

type PeerListener = (event: MobileRealtimeTrackEvent | undefined) => void;

class FakePeer implements MobileRealtimePeerConnection {
  connectionState = "new";
  readonly addedTracks: MobileRealtimeMediaTrack[] = [];
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });
  readonly createOfferCalls: unknown[] = [];
  readonly localDescriptions: unknown[] = [];
  readonly remoteDescriptions: unknown[] = [];
  readonly remoteDescriptionStarted = deferred<void>();
  readonly remoteDescriptionFinished = deferred<void>();
  private readonly listeners = new Map<MobileRealtimePeerEventType, Set<PeerListener>>();

  constructor(
    readonly channel: FakeDataChannel,
    private readonly remoteDescriptionGate?: Deferred<void>,
    private readonly dataChannelError?: unknown,
    private readonly offerGate?: Deferred<{ readonly type: "offer"; readonly sdp: string }>,
    private readonly localDescriptionGate?: Deferred<void>,
  ) {}

  createDataChannel(label: string): MobileRealtimeDataChannel {
    if (this !== this.receiver()) throw new Error("createDataChannel lost receiver");
    if (this.dataChannelError !== undefined) throw this.dataChannelError;
    expect(label).toBe("oai-events");
    return this.channel;
  }

  addTrack(track: MobileRealtimeMediaTrack, _stream: MobileRealtimeMediaStream): unknown {
    this.addedTracks.push(track);
    return { track };
  }

  async createOffer(): Promise<{ readonly type: "offer"; readonly sdp: string }> {
    if (this !== this.receiver()) throw new Error("createOffer lost receiver");
    this.createOfferCalls.push(undefined);
    return this.offerGate?.promise ?? { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: {
    readonly type: "offer";
    readonly sdp?: string;
  }): Promise<void> {
    if (this !== this.receiver()) throw new Error("setLocalDescription lost receiver");
    this.localDescriptions.push(description);
    if (this.localDescriptionGate) await this.localDescriptionGate.promise;
  }

  async setRemoteDescription(description: {
    readonly type: "answer";
    readonly sdp: string;
  }): Promise<void> {
    if (this !== this.receiver()) throw new Error("setRemoteDescription lost receiver");
    this.remoteDescriptions.push(description);
    this.remoteDescriptionStarted.resolve();
    if (this.remoteDescriptionGate) await this.remoteDescriptionGate.promise;
    this.remoteDescriptionFinished.resolve();
  }

  addEventListener(type: MobileRealtimePeerEventType, listener: PeerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<PeerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: MobileRealtimePeerEventType, listener: PeerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getSenders() {
    return this.addedTracks.map((track) => ({ track }));
  }

  getReceivers() {
    return [];
  }

  emitConnectionState(state: string): void {
    this.connectionState = state;
    for (const listener of this.listeners.get("connectionstatechange") ?? []) listener(undefined);
  }

  emitTrack(
    track: MobileRealtimeMediaTrack | null,
    streams: MobileRealtimeMediaStream[] = [],
  ): void {
    for (const listener of this.listeners.get("track") ?? []) listener({ track, streams });
  }

  private receiver(): this {
    return this;
  }
}

class FakeResponse implements MobileRealtimeResponse {
  readonly textCalls: unknown[] = [];

  constructor(
    readonly ok = true,
    readonly status = 200,
    private readonly body = "answer-sdp",
    private readonly bodyGate?: Deferred<string>,
  ) {}

  async text(): Promise<string> {
    if (this !== this.receiver()) throw new Error("response.text lost receiver");
    this.textCalls.push(undefined);
    return this.bodyGate ? this.bodyGate.promise : this.body;
  }

  private receiver(): this {
    return this;
  }
}

function clientSecret(value = "ek_short_lived") {
  return {
    clientSecret: value,
    expiresAt: 2_000,
    sessionId: "session-mobile",
  };
}

function connectInput(
  overrides: Partial<RealtimeTransportConnectInput> = {},
): RealtimeTransportConnectInput {
  return {
    getClientSecret: async () => clientSecret(),
    ...overrides,
  };
}

function harness(
  options: {
    readonly initialAppState?: MobileVoiceAppState;
    readonly getAppState?: () => MobileVoiceAppState;
    readonly onSubscribeAppState?: (listener: (state: MobileVoiceAppState) => void) => void;
    readonly permission?: () => Promise<boolean>;
    readonly audioStart?: (listener: (event: MobileVoiceAudioSessionEvent) => void) => void;
    readonly getUserMedia?: (
      constraints: typeof MOBILE_REALTIME_MEDIA_CONSTRAINTS,
    ) => Promise<MobileRealtimeMediaStream>;
    readonly createPeerConnection?: () => MobileRealtimePeerConnection;
    readonly fetch?: MobileRealtimeSessionDependencies["fetch"];
    readonly stream?: FakeStream;
    readonly peer?: FakePeer;
    readonly channel?: FakeDataChannel;
  } = {},
) {
  let appState = options.initialAppState ?? "active";
  const appListeners = new Set<(state: MobileVoiceAppState) => void>();
  const audioListeners = new Set<(event: MobileVoiceAudioSessionEvent) => void>();
  const removeAppListener = vi.fn();
  const removeAudioListener = vi.fn();
  const track = new FakeTrack();
  const stream = options.stream ?? new FakeStream([track]);
  const channel = options.channel ?? new FakeDataChannel();
  const peer = options.peer ?? new FakePeer(channel);
  const requestMicrophonePermission = vi.fn(options.permission ?? (async () => true));
  const audioStart = vi.fn(options.audioStart ?? (() => undefined));
  const audioStop = vi.fn();
  const getUserMedia = vi.fn(options.getUserMedia ?? (async () => stream));
  const createPeerConnection = vi.fn(options.createPeerConnection ?? (() => peer));
  const response = new FakeResponse();
  const fetch = vi.fn(options.fetch ?? (async () => response));
  const scheduled = new Map<
    ReturnType<typeof setTimeout>,
    { readonly callback: () => void; readonly delayMs: number }
  >();
  const schedule = vi.fn((callback: () => void, delayMs: number) => {
    const handle = setTimeout(() => undefined, 0);
    clearTimeout(handle);
    scheduled.set(handle, { callback, delayMs });
    return handle;
  });
  const cancelScheduled = vi.fn((handle: ReturnType<typeof setTimeout>) => {
    scheduled.delete(handle);
  });
  const dependencies: MobileRealtimeSessionDependencies = {
    getAppState: options.getAppState ?? (() => appState),
    subscribeToAppState: (listener) => {
      appListeners.add(listener);
      options.onSubscribeAppState?.(listener);
      return () => {
        appListeners.delete(listener);
        removeAppListener();
      };
    },
    requestMicrophonePermission,
    getUserMedia,
    createPeerConnection,
    audioSession: {
      start: (listener) => {
        audioListeners.add(listener);
        try {
          audioStart(listener);
        } catch (error) {
          audioListeners.delete(listener);
          removeAudioListener();
          throw error;
        }
        let stopped = false;
        return {
          stop: () => {
            if (stopped) return;
            stopped = true;
            audioListeners.delete(listener);
            removeAudioListener();
            audioStop();
          },
        };
      },
    },
    fetch,
    nowEpochMs: () => 1_000_000,
    schedule,
    cancelScheduled,
  };
  const controller = createMobileRealtimeSessionControllerCore(dependencies);
  return {
    controller,
    track,
    stream,
    channel,
    peer,
    response,
    requestMicrophonePermission,
    audioStart,
    audioStop,
    getUserMedia,
    createPeerConnection,
    fetch,
    schedule,
    cancelScheduled,
    scheduled,
    removeAppListener,
    removeAudioListener,
    setAppState(state: MobileVoiceAppState, emit = true) {
      appState = state;
      if (emit) for (const listener of appListeners) listener(state);
    },
    emitAudioEvent(event: MobileVoiceAudioSessionEvent) {
      for (const listener of audioListeners) listener(event);
    },
    runNegotiationTimeout() {
      for (const [handle, task] of scheduled) {
        if (task.delayMs !== MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS) continue;
        scheduled.delete(handle);
        task.callback();
      }
    },
  };
}

describe("mobile Realtime session core", () => {
  it.each(["inactive", "background", "unknown", "extension"] as const)(
    "rejects initial %s state before permission or native resources",
    async (initialAppState) => {
      const setup = harness({ initialAppState });
      const attempt = setup.controller.connect(connectInput());

      await expect(attempt.ready).rejects.toMatchObject({ reason: "connection_failed" });
      expect(setup.requestMicrophonePermission).not.toHaveBeenCalled();
      expect(setup.audioStart).not.toHaveBeenCalled();
      expect(setup.getUserMedia).not.toHaveBeenCalled();
      expect(setup.createPeerConnection).not.toHaveBeenCalled();
      expect(setup.fetch).not.toHaveBeenCalled();
    },
  );

  it("closes the initial AppState check/subscription race", async () => {
    const reads: MobileVoiceAppState[] = ["active", "background"];
    const setup = harness({ getAppState: () => reads.shift() ?? "background" });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not enter a queued permission stage after synchronous disposal", async () => {
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));

    setup.controller.dispose();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(states.mock.calls.map(([event]) => event.state)).toEqual(["connecting", "closed"]);
  });

  it("does no work when the initial connecting callback disposes reentrantly", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput({
        onTransportState: ({ state }) => {
          if (state === "connecting") setup.controller.dispose();
        },
      }),
    );

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(setup.audioStart).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.removeAppListener).not.toHaveBeenCalled();
    expect(setup.removeAudioListener).not.toHaveBeenCalled();
  });

  it("removes a lifecycle listener installed during synchronous foreground loss", async () => {
    const setup = harness({
      onSubscribeAppState: (listener) => listener("background"),
    });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.requestMicrophonePermission).not.toHaveBeenCalled();
    expect(setup.removeAppListener).toHaveBeenCalledOnce();
    expect(setup.removeAudioListener).not.toHaveBeenCalled();
  });

  it("denies microphone access without constructing a peer or minting", async () => {
    const getClientSecret = vi.fn(async () => clientSecret("raw-secret-must-not-escape"));
    const setup = harness({ permission: async () => false });
    const attempt = setup.controller.connect(connectInput({ getClientSecret }));

    await expect(attempt.ready).rejects.toMatchObject({
      reason: "microphone_access_failed",
      message: "T3 Code could not access the microphone.",
    });
    expect(setup.audioStart).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(getClientSecret).not.toHaveBeenCalled();
  });

  it("waits for active after an iOS permission prompt without holding a negotiation timer", async () => {
    const permission = deferred<boolean>();
    const setup = harness({ permission: () => permission.promise });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.requestMicrophonePermission).toHaveBeenCalledOnce());

    setup.setAppState("inactive");
    permission.resolve(true);
    await flushPromises();

    expect(setup.audioStart).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.scheduled.size).toBe(0);

    setup.setAppState("active");
    await attempt.ready;
    expect(setup.audioStart).toHaveBeenCalledOnce();
    expect(setup.getUserMedia).toHaveBeenCalledWith(MOBILE_REALTIME_MEDIA_CONSTRAINTS);
    setup.controller.dispose();
  });

  it("terminates on background during permission and ignores late resolution", async () => {
    const permission = deferred<boolean>();
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({ permission: () => permission.promise });
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
    await vi.waitFor(() => expect(setup.requestMicrophonePermission).toHaveBeenCalledOnce());

    setup.setAppState("inactive");
    setup.setAppState("background");

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(states).toHaveBeenLastCalledWith({ generation: attempt.generation, state: "closed" });
    permission.resolve(true);
    await flushPromises();
    expect(setup.audioStart).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
  });

  it("redacts an audio-session activation failure and never captures media", async () => {
    const setup = harness({
      audioStart: () => {
        throw new Error("AVAudioSession raw internal failure");
      },
    });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({
      reason: "connection_failed",
      message: "The voice connection failed.",
    });
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(setup.audioStop).not.toHaveBeenCalled();
  });

  it("stops a synchronously interrupted audio-session lease without capturing media", async () => {
    const setup = harness({ audioStart: (listener) => listener("interruption") });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.audioStart).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
    expect(setup.removeAudioListener).toHaveBeenCalledOnce();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
  });

  it("rejects and releases a captured stream with no audio track", async () => {
    const videoTrack = new FakeTrack("video");
    const stream = new FakeStream([videoTrack]);
    const setup = harness({ stream });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({ reason: "microphone_access_failed" });
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(stream.release).toHaveBeenCalledWith(true);
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(setup.audioStop).toHaveBeenCalledOnce();
  });

  it("posts the exact SDP offer only after media and preserves method receivers", async () => {
    const order: string[] = [];
    const response = new FakeResponse();
    const setup = harness({
      permission: async () => {
        order.push("permission");
        return true;
      },
      audioStart: () => {
        order.push("audio");
      },
      getUserMedia: async (constraints) => {
        order.push("media");
        expect(constraints).toEqual(MOBILE_REALTIME_MEDIA_CONSTRAINTS);
        return new FakeStream([new FakeTrack()]);
      },
      fetch: async (_url, _init) => {
        order.push("fetch");
        return response;
      },
    });
    let suppliedSignal: AbortSignal | undefined;
    const attempt = setup.controller.connect(
      connectInput({
        getClientSecret: async (signal) => {
          order.push("secret");
          suppliedSignal = signal;
          return clientSecret("ek_exact_mobile_secret");
        },
      }),
    );

    await attempt.ready;

    expect(order).toEqual(["permission", "audio", "media", "secret", "fetch"]);
    expect(setup.peer.createOfferCalls).toHaveLength(1);
    expect(setup.peer.localDescriptions).toEqual([{ type: "offer", sdp: "offer-sdp" }]);
    expect(setup.fetch).toHaveBeenCalledWith(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      body: "offer-sdp",
      headers: {
        Authorization: "Bearer ek_exact_mobile_secret",
        "Content-Type": "application/sdp",
      },
      signal: suppliedSignal,
    });
    expect(setup.peer.remoteDescriptions).toEqual([{ type: "answer", sdp: "answer-sdp" }]);
    expect(response.textCalls).toHaveLength(1);
    setup.controller.dispose();
  });

  it("starts the bounded negotiation timer only after local media resolves", async () => {
    const media = deferred<MobileRealtimeMediaStream>();
    const setup = harness({ getUserMedia: () => media.promise });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.getUserMedia).toHaveBeenCalledOnce());

    expect(setup.scheduled.size).toBe(0);
    media.resolve(setup.stream);
    await attempt.ready;
    expect(setup.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS,
    );
    expect(setup.scheduled.size).toBe(0);
    setup.controller.dispose();
  });

  it("stops during offer creation and ignores its late completion", async () => {
    const offer = deferred<{ readonly type: "offer"; readonly sdp: string }>();
    const channel = new FakeDataChannel();
    const peer = new FakePeer(channel, undefined, undefined, offer);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(peer.createOfferCalls).toHaveLength(1));

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    offer.resolve({ type: "offer", sdp: "late-offer" });
    await flushPromises();

    expect(peer.localDescriptions).toHaveLength(0);
    expect(setup.fetch).not.toHaveBeenCalled();
    expect(setup.stream.release).toHaveBeenCalledOnce();
  });

  it("closes the already-owned peer when data-channel construction throws", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeer(
      channel,
      undefined,
      new Error("native data-channel constructor details"),
    );
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput());

    await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_failed" });
    expect(peer.close).toHaveBeenCalledOnce();
    expect(channel.close).not.toHaveBeenCalled();
    expect(setup.stream.release).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
  });

  it("stops during local-description setup and never mints after late completion", async () => {
    const localDescription = deferred<void>();
    const channel = new FakeDataChannel();
    const peer = new FakePeer(channel, undefined, undefined, undefined, localDescription);
    const getClientSecret = vi.fn(async () => clientSecret());
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput({ getClientSecret }));
    await vi.waitFor(() => expect(peer.localDescriptions).toHaveLength(1));

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    localDescription.resolve();
    await flushPromises();

    expect(getClientSecret).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("stops during secret mint and never starts the SDP request", async () => {
    const secret = deferred<ReturnType<typeof clientSecret>>();
    const getClientSecret = vi.fn(() => secret.promise);
    const setup = harness();
    const attempt = setup.controller.connect(connectInput({ getClientSecret }));
    await vi.waitFor(() => expect(getClientSecret).toHaveBeenCalledOnce());

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    secret.resolve(clientSecret());
    await flushPromises();

    expect(setup.fetch).not.toHaveBeenCalled();
    expect(setup.stream.release).toHaveBeenCalledOnce();
  });

  it("aborts a never-resolving SDP request on negotiation timeout", async () => {
    const fetchStarted = deferred<AbortSignal>();
    const response = deferred<MobileRealtimeResponse>();
    const setup = harness({
      fetch: async (_url, init) => {
        fetchStarted.resolve(init.signal);
        return response.promise;
      },
    });
    const attempt = setup.controller.connect(connectInput());
    const signal = await fetchStarted.promise;

    setup.runNegotiationTimeout();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_timeout" });
    expect(signal.aborted).toBe(true);
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.stream.release).toHaveBeenCalledWith(true);
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();

    response.resolve(new FakeResponse());
    await flushPromises();
    expect(setup.peer.remoteDescriptions).toHaveLength(0);
  });

  it("times out when the native data channel never opens", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeer(channel);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput());
    await peer.remoteDescriptionFinished.promise;

    setup.runNegotiationTimeout();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_timeout" });
    expect(channel.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("stops while reading the SDP response and ignores the late answer", async () => {
    const answer = deferred<string>();
    const response = new FakeResponse(true, 200, "unused", answer);
    const setup = harness({ fetch: async () => response });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(response.textCalls).toHaveLength(1));

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    answer.resolve("late-answer");
    await flushPromises();

    expect(setup.peer.remoteDescriptions).toHaveLength(0);
  });

  it("stops during remote-description setup and never reports connected", async () => {
    const remote = deferred<void>();
    const channel = new FakeDataChannel();
    const peer = new FakePeer(channel, remote);
    const states = vi.fn<(state: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
    await peer.remoteDescriptionStarted.promise;

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    remote.resolve();
    await flushPromises();

    expect(states.mock.calls.map(([state]) => state.state)).toEqual(["connecting", "closed"]);
  });

  it("stops while waiting for channel open and ignores the late callback", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeer(channel);
    const states = vi.fn<(state: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
    await peer.remoteDescriptionFinished.promise;

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    channel.emit("open");
    await flushPromises();

    expect(states.mock.calls.map(([state]) => state.state)).toEqual(["connecting", "closed"]);
  });

  it.each(["failed", "closed"])(
    "rejects a peer that becomes %s before readiness",
    async (state) => {
      const remoteGate = deferred<void>();
      const channel = new FakeDataChannel();
      const peer = new FakePeer(channel, remoteGate);
      const setup = harness({ channel, peer });
      const attempt = setup.controller.connect(connectInput());
      await peer.remoteDescriptionStarted.promise;

      peer.emitConnectionState(state);

      await expect(attempt.ready).rejects.toMatchObject({ reason: "connection_failed" });
      remoteGate.resolve();
    },
  );

  it.each(["error", "close"] as const)("rejects a pre-ready data-channel %s", async (event) => {
    const remoteGate = deferred<void>();
    const channel = new FakeDataChannel();
    const peer = new FakePeer(channel, remoteGate);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput());
    await peer.remoteDescriptionStarted.promise;

    channel.emit(event);

    await expect(attempt.ready).rejects.toMatchObject({ reason: "data_channel_failed" });
    remoteGate.resolve();
  });

  it("stops and releases stale media after disposal without touching later stages", async () => {
    const media = deferred<MobileRealtimeMediaStream>();
    const staleTrack = new FakeTrack();
    const staleStream = new FakeStream([staleTrack]);
    const setup = harness({ getUserMedia: () => media.promise });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.getUserMedia).toHaveBeenCalledOnce());

    setup.controller.dispose();
    media.resolve(staleStream);

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    await flushPromises();
    expect(staleTrack.stop).toHaveBeenCalledOnce();
    expect(staleStream.release).toHaveBeenCalledOnce();
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("tears down on foreground loss while media capture is pending", async () => {
    const media = deferred<MobileRealtimeMediaStream>();
    const staleTrack = new FakeTrack();
    const staleStream = new FakeStream([staleTrack]);
    const setup = harness({ getUserMedia: () => media.promise });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.getUserMedia).toHaveBeenCalledOnce());

    setup.setAppState("background");
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.audioStop).toHaveBeenCalledOnce();

    media.resolve(staleStream);
    await flushPromises();
    expect(staleTrack.stop).toHaveBeenCalledOnce();
    expect(staleStream.release).toHaveBeenCalledWith(true);
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
  });

  it("supersedes generations and ignores retained old channel callbacks", async () => {
    const channels = [new FakeDataChannel(), new FakeDataChannel()];
    const peers = channels.map((channel) => new FakePeer(channel));
    const streams = [new FakeStream([new FakeTrack()]), new FakeStream([new FakeTrack()])];
    let peerIndex = 0;
    let mediaIndex = 0;
    const setup = harness({
      createPeerConnection: () => peers[peerIndex++]!,
      getUserMedia: async () => streams[mediaIndex++]!,
    });
    const staleEvents = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const currentEvents = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const first = setup.controller.connect(connectInput({ onServerEvent: staleEvents }));
    await first.ready;
    const retained = channels[0]!.retainedMessageListeners();

    const second = setup.controller.connect(connectInput({ onServerEvent: currentEvents }));
    await second.ready;
    for (const listener of retained) {
      listener({
        data: JSON.stringify({
          event_id: "old-event",
          type: "session.created",
          session: { id: "old-session" },
        }),
      });
    }

    expect(staleEvents).not.toHaveBeenCalled();
    expect(currentEvents).not.toHaveBeenCalled();
    expect(first.generation).not.toBe(second.generation);
    expect(streams[0]!.release).toHaveBeenCalledOnce();
    setup.controller.dispose();
  });

  it("supersedes a pending permission generation without letting it resurrect", async () => {
    const stalePermission = deferred<boolean>();
    let permissionRequest = 0;
    const setup = harness({
      permission: async () => {
        permissionRequest += 1;
        return permissionRequest === 1 ? stalePermission.promise : true;
      },
    });
    const first = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.requestMicrophonePermission).toHaveBeenCalledOnce());

    const second = setup.controller.connect(connectInput());
    await second.ready;
    await expect(first.ready).rejects.toMatchObject({ reason: "aborted" });
    stalePermission.resolve(true);
    await flushPromises();

    expect(setup.requestMicrophonePermission).toHaveBeenCalledTimes(2);
    expect(setup.audioStart).toHaveBeenCalledOnce();
    expect(setup.getUserMedia).toHaveBeenCalledOnce();
    expect(setup.createPeerConnection).toHaveBeenCalledOnce();
    setup.controller.dispose();
  });

  it("projects only decoded events and canonical completed function calls", async () => {
    const events = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const calls = vi.fn<(event: RealtimeFunctionCallEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput({ onServerEvent: events, onFunctionCalls: calls }),
    );
    await attempt.ready;

    setup.channel.emit("message", { data: new Uint8Array([1, 2]) });
    setup.channel.emit("message", { data: "not-json" });
    setup.channel.emit("message", {
      data: JSON.stringify({ event_id: "unknown", type: "future.event" }),
    });
    setup.channel.emit("message", {
      data: JSON.stringify({
        event_id: "done-1",
        type: "response.done",
        response: {
          id: "response-1",
          status: "completed",
          output: [
            {
              id: "item-1",
              type: "function_call",
              call_id: "call-1",
              name: "list_projects",
              arguments: "{}",
              status: "completed",
            },
            {
              id: "item-2",
              type: "function_call",
              call_id: "call-2",
              name: "ignored_partial",
              arguments: "{}",
              status: "in_progress",
            },
          ],
        },
      }),
    });

    expect(events).toHaveBeenCalledOnce();
    expect(calls).toHaveBeenCalledWith({
      generation: attempt.generation,
      calls: [
        {
          itemId: "item-1",
          callId: "call-1",
          name: "list_projects",
          arguments: "{}",
        },
      ],
    });
    setup.controller.dispose();
  });

  it("rechecks ownership when an event callback disposes synchronously", async () => {
    const calls = vi.fn<(event: RealtimeFunctionCallEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput({
        onServerEvent: () => setup.controller.dispose(),
        onFunctionCalls: calls,
      }),
    );
    await attempt.ready;

    setup.channel.emit("message", {
      data: JSON.stringify({
        event_id: "done-dispose",
        type: "response.done",
        response: {
          id: "response-dispose",
          status: "completed",
          output: [
            {
              id: "item-dispose",
              type: "function_call",
              call_id: "call-dispose",
              name: "list_threads",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
      }),
    });

    expect(calls).not.toHaveBeenCalled();
  });

  it("serializes a complete correlated tool-output batch before sending once", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;

    setup.controller.sendSessionUpdate({ type: "realtime", model: "gpt-realtime-2.1" });
    setup.controller.sendToolOutputs({
      outputs: [
        { eventId: "output-1", callId: "call-1", output: { ok: 1 } },
        { eventId: "output-2", callId: "call-2", output: "denied" },
      ],
      responseCreateEventId: "continue-1",
    });

    expect(setup.channel.sent.map((value) => JSON.parse(value))).toEqual([
      {
        type: "session.update",
        session: { type: "realtime", model: "gpt-realtime-2.1" },
      },
      {
        event_id: "output-1",
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: '{"ok":1}',
        },
      },
      {
        event_id: "output-2",
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call-2", output: "denied" },
      },
      { event_id: "continue-1", type: "response.create" },
    ]);
    setup.controller.dispose();
  });

  it("does not partially send an unserializable tool batch", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      setup.controller.sendToolOutputs({
        outputs: [
          { eventId: "output-valid", callId: "call-valid", output: "valid" },
          { eventId: "output-invalid", callId: "call-invalid", output: circular },
        ],
        responseCreateEventId: "continue-invalid",
      }),
    ).toThrow(expect.objectContaining({ reason: "serialization_failed" }));
    expect(setup.channel.sent).toEqual([]);
    setup.controller.dispose();
  });

  it("applies mute before media arrives and to later toggles", async () => {
    const media = deferred<MobileRealtimeMediaStream>();
    const track = new FakeTrack();
    const stream = new FakeStream([track]);
    const setup = harness({ getUserMedia: () => media.promise });
    const attempt = setup.controller.connect(connectInput());
    await vi.waitFor(() => expect(setup.getUserMedia).toHaveBeenCalledOnce());

    setup.controller.setMuted(true);
    media.resolve(stream);
    await attempt.ready;
    expect(track.enabled).toBe(false);

    setup.controller.setMuted(false);
    expect(track.enabled).toBe(true);
    setup.controller.dispose();
  });

  it("keeps remote audio native, rejects video, and cleans streamless tracks", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;
    const remoteAudio = new FakeTrack("audio");
    const remoteVideo = new FakeTrack("video");

    setup.peer.emitTrack(null, []);
    setup.peer.emitTrack(remoteAudio, []);
    setup.peer.emitTrack(remoteVideo, []);

    expect(remoteAudio.stop).not.toHaveBeenCalled();
    expect(remoteVideo.stop).toHaveBeenCalledOnce();
    setup.controller.dispose();
    expect(remoteAudio.stop).toHaveBeenCalledOnce();
  });

  it.each(["interruption", "route_lost", "media_services_reset"] as const)(
    "tears down exactly once for native audio event %s and never auto-resumes",
    async (event) => {
      const states = vi.fn<(state: RealtimeTransportStateEnvelope) => void>();
      const setup = harness();
      const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
      await attempt.ready;

      setup.emitAudioEvent(event);
      setup.emitAudioEvent(event);
      setup.setAppState("active");

      expect(setup.track.stop).toHaveBeenCalledOnce();
      expect(setup.stream.release).toHaveBeenCalledOnce();
      expect(setup.audioStop).toHaveBeenCalledOnce();
      expect(setup.channel.close).toHaveBeenCalledOnce();
      expect(setup.peer.close).toHaveBeenCalledOnce();
      expect(states.mock.calls.map(([state]) => state.state)).toEqual([
        "connecting",
        "connected",
        "closed",
      ]);
    },
  );

  it("distinguishes a transient peer disconnect from terminal foreground loss", async () => {
    const states = vi.fn<(state: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
    await attempt.ready;

    setup.peer.emitConnectionState("disconnected");
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "disconnected",
    });
    expect(setup.track.stop).not.toHaveBeenCalled();

    setup.setAppState("inactive");
    expect(states).toHaveBeenLastCalledWith({ generation: attempt.generation, state: "closed" });
    expect(setup.track.stop).toHaveBeenCalledOnce();
  });

  it("treats a post-ready data-channel close as terminal", async () => {
    const states = vi.fn<(state: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(connectInput({ onTransportState: states }));
    await attempt.ready;

    setup.channel.emit("close");

    expect(states).toHaveBeenLastCalledWith({ generation: attempt.generation, state: "closed" });
    expect(setup.stream.release).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
  });

  it("redacts secret, fetch, and response failures without logging raw causes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rawSecret = "raw-client-secret-value";
    const setup = harness({
      fetch: async () => {
        throw new Error(`provider rejected ${rawSecret}`);
      },
    });
    const attempt = setup.controller.connect(
      connectInput({ getClientSecret: async () => clientSecret(rawSecret) }),
    );

    let failure: unknown;
    try {
      await attempt.ready;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      reason: "negotiation_failed",
      message: "T3 Code could not establish the voice connection.",
    });
    expect(String(failure)).not.toContain(rawSecret);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("maps a raw secret-mint rejection to the safe client-secret failure", async () => {
    const raw = "bearer credential and host details";
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput({
        getClientSecret: async () => {
          throw new Error(raw);
        },
      }),
    );

    let failure: unknown;
    try {
      await attempt.ready;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      reason: "client_secret_failed",
      message: "T3 Code could not start a voice session.",
    });
    expect(String(failure)).not.toContain(raw);
  });

  it.each([
    ["expired", clientSecret("expired-secret")],
    ["empty", { ...clientSecret(), clientSecret: "" }],
    ["oversized", { ...clientSecret(), clientSecret: "x".repeat(4_097) }],
  ])("rejects an %s client secret without contacting the upstream", async (_label, secret) => {
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput({
        getClientSecret: async () =>
          _label === "expired" ? { ...secret, expiresAt: 1_000 } : secret,
      }),
    );

    await expect(attempt.ready).rejects.toMatchObject({
      reason: _label === "expired" ? "client_secret_expired" : "client_secret_failed",
    });
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("does not read or expose a rejected upstream response body", async () => {
    const response = new FakeResponse(false, 401, "raw provider response and secret");
    const setup = harness({ fetch: async () => response });
    const attempt = setup.controller.connect(connectInput());

    let failure: unknown;
    try {
      await attempt.ready;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ reason: "upstream_rejected" });
    expect(String(failure)).not.toContain("raw provider response");
    expect(response.textCalls).toHaveLength(0);
  });

  it.each(["", "x".repeat(1_000_001)])(
    "rejects an empty or oversized offer before minting",
    async (sdp) => {
      const offer = deferred<{ readonly type: "offer"; readonly sdp: string }>();
      offer.resolve({ type: "offer", sdp });
      const channel = new FakeDataChannel();
      const peer = new FakePeer(channel, undefined, undefined, offer);
      const getClientSecret = vi.fn(async () => clientSecret());
      const setup = harness({ channel, peer });
      const attempt = setup.controller.connect(connectInput({ getClientSecret }));

      await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_failed" });
      expect(getClientSecret).not.toHaveBeenCalled();
      expect(setup.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "x".repeat(1_000_001)])(
    "rejects an empty or oversized answer before remote description",
    async (sdp) => {
      const response = new FakeResponse(true, 200, sdp);
      const setup = harness({ fetch: async () => response });
      const attempt = setup.controller.connect(connectInput());

      await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_failed" });
      expect(setup.peer.remoteDescriptions).toHaveLength(0);
    },
  );

  it("continues one-shot cleanup when individual native disposers throw", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;
    setup.track.stop.mockImplementation(() => {
      throw new Error("track stop failed");
    });
    setup.stream.release.mockImplementation(() => {
      throw new Error("stream release failed");
    });
    setup.channel.close.mockImplementation(() => {
      throw new Error("channel close failed");
    });
    setup.peer.close.mockImplementation(() => {
      throw new Error("peer close failed");
    });
    setup.audioStop.mockImplementation(() => {
      throw new Error("audio stop failed");
    });

    expect(() => setup.controller.dispose()).not.toThrow();
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.stream.release).toHaveBeenCalledOnce();
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
    expect(setup.removeAppListener).toHaveBeenCalledOnce();
    expect(setup.removeAudioListener).toHaveBeenCalledOnce();
  });

  it("still releases the stream and session when failed-peer inspection throws", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;
    vi.spyOn(setup.stream, "getTracks").mockImplementation(() => {
      throw new Error("stream tracks unavailable");
    });
    vi.spyOn(setup.peer, "getSenders").mockImplementation(() => {
      throw new Error("senders unavailable");
    });
    vi.spyOn(setup.peer, "getReceivers").mockImplementation(() => {
      throw new Error("receivers unavailable");
    });

    expect(() => setup.controller.dispose()).not.toThrow();
    expect(setup.stream.release).toHaveBeenCalledWith(true);
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
  });

  it("removes lifecycle listeners and releases every owned resource once", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput());
    await attempt.ready;

    setup.controller.dispose();
    setup.controller.dispose();

    expect(setup.removeAppListener).toHaveBeenCalledOnce();
    expect(setup.removeAudioListener).toHaveBeenCalledOnce();
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.stream.release).toHaveBeenCalledOnce();
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
    expect(setup.audioStop).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import {
  createRealtimeSessionController,
  OPENAI_REALTIME_CALLS_URL,
  REALTIME_MEDIA_CONSTRAINTS,
  REALTIME_NEGOTIATION_TIMEOUT_MS,
  RealtimeSessionError,
  type RealtimeFunctionCallEnvelope,
  type RealtimeServerEventEnvelope,
  type RealtimeSessionConnectInput,
  type RealtimeSessionDependencies,
  type RealtimeTransportStateEnvelope,
} from "./realtimeSession";

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

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeTrack {
  enabled = true;
  readonly stop: ReturnType<typeof vi.fn>;

  constructor(onStop: () => void = () => {}) {
    this.stop = vi.fn(onStop);
  }
}

class FakeStream {
  constructor(private readonly tracks: ReadonlyArray<FakeTrack>) {}

  getTracks() {
    return [...this.tracks] as unknown as MediaStreamTrack[];
  }

  getAudioTracks() {
    return [...this.tracks] as unknown as MediaStreamTrack[];
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly close = vi.fn(() => {
    this.readyState = "closed";
  });

  constructor(initialState: RTCDataChannelState = "open") {
    this.readyState = initialState;
  }

  send(value: string) {
    this.sent.push(value);
  }

  addEventListener(type: string, listener: unknown) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: unknown) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: unknown) {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  open() {
    this.readyState = "open";
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }

  message(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  error() {
    for (const listener of this.listeners.get("error") ?? []) listener({});
  }

  closeFromRemote() {
    this.readyState = "closed";
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }

  retainedMessageListeners() {
    return [...(this.listeners.get("message") ?? [])];
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  readonly addedTracks: FakeTrack[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly remoteDescriptionStarted = deferred<void>();
  readonly remoteDescriptionFinished = deferred<void>();
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }) as const);
  readonly setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {
    this.remoteDescriptionStarted.resolve();
    if (this.remoteDescriptionGate) await this.remoteDescriptionGate.promise;
    this.remoteDescriptionFinished.resolve();
  });
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
  });

  constructor(
    readonly channel: FakeDataChannel,
    private readonly remoteDescriptionGate?: Deferred<void>,
    private readonly dataChannelError?: unknown,
  ) {}

  createDataChannel(_label: string) {
    if (this.dataChannelError) throw this.dataChannelError;
    return this.channel as unknown as RTCDataChannel;
  }

  addEventListener(type: string, listener: unknown) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: unknown) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: unknown) {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  addTrack(track: MediaStreamTrack, _stream: MediaStream) {
    this.addedTracks.push(track as unknown as FakeTrack);
    return { track } as RTCRtpSender;
  }

  getSenders() {
    return this.addedTracks.map((track) => ({ track })) as unknown as RTCRtpSender[];
  }

  getReceivers() {
    return [] as RTCRtpReceiver[];
  }

  emitTrack(track: FakeTrack, stream: FakeStream) {
    const event = {
      track: track as unknown as MediaStreamTrack,
      streams: [stream as unknown as MediaStream],
    } as unknown as RTCTrackEvent;
    for (const listener of this.listeners.get("track") ?? []) listener(event);
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    for (const listener of this.listeners.get("connectionstatechange") ?? []) listener({});
  }
}

class FakeAudioElement {
  srcObject: MediaProvider | null = null;
  readonly play = vi.fn(async () => {});
  readonly pause = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly load = vi.fn();
}

function clientSecret(value = "ek_short_lived") {
  return {
    clientSecret: value,
    expiresAt: 2_000,
    sessionId: "session-1",
  };
}

function connectInput(
  audio: FakeAudioElement,
  overrides: Partial<RealtimeSessionConnectInput> = {},
): RealtimeSessionConnectInput {
  return {
    audioElement: audio as unknown as HTMLAudioElement,
    getClientSecret: async () => clientSecret(),
    ...overrides,
  };
}

function harness(
  options: {
    readonly secure?: boolean;
    readonly channel?: FakeDataChannel;
    readonly peer?: FakePeerConnection;
    readonly stream?: FakeStream;
    readonly getUserMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
    readonly fetch?: RealtimeSessionDependencies["fetch"];
  } = {},
) {
  const track = new FakeTrack();
  const stream = options.stream ?? new FakeStream([track]);
  const channel = options.channel ?? new FakeDataChannel();
  const peer = options.peer ?? new FakePeerConnection(channel);
  const getUserMedia = vi.fn(
    options.getUserMedia ?? (async () => stream as unknown as MediaStream),
  );
  const fetch = vi.fn(options.fetch ?? (async () => new Response("answer-sdp", { status: 200 })));
  const createPeerConnection = vi.fn(() => peer as unknown as RTCPeerConnection);
  const getMediaDevices = vi.fn(
    () => ({ getUserMedia }) as unknown as Pick<MediaDevices, "getUserMedia">,
  );
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
  const controller = createRealtimeSessionController({
    isSecureContext: () => options.secure ?? true,
    getMediaDevices,
    createPeerConnection,
    fetch,
    nowEpochMs: () => 1_000_000,
    schedule,
    cancelScheduled,
  });
  const runScheduled = (delayMs: number) => {
    const matches = [...scheduled.entries()].filter(([, task]) => task.delayMs === delayMs);
    for (const [handle, task] of matches) {
      scheduled.delete(handle);
      task.callback();
    }
  };
  return {
    controller,
    track,
    stream,
    channel,
    peer,
    getUserMedia,
    getMediaDevices,
    createPeerConnection,
    fetch,
    scheduled,
    schedule,
    cancelScheduled,
    runScheduled,
  };
}

describe("RealtimeSessionController", () => {
  it("fails before requesting media outside a secure context", async () => {
    const setup = harness({ secure: false });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));

    await expect(attempt.ready).rejects.toMatchObject({ reason: "insecure_context" });
    expect(setup.getMediaDevices).not.toHaveBeenCalled();
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("fails safely when mediaDevices is unavailable", async () => {
    const createPeerConnection = vi.fn();
    const controller = createRealtimeSessionController({
      isSecureContext: () => true,
      getMediaDevices: () => undefined,
      createPeerConnection,
    });
    const attempt = controller.connect(connectInput(new FakeAudioElement()));

    await expect(attempt.ready).rejects.toMatchObject({ reason: "media_devices_unavailable" });
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  it("does not start queued browser effects after synchronous disposal", async () => {
    const setup = harness();
    const getClientSecret = vi.fn(async () => clientSecret());
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { getClientSecret, onTransportState: states }),
    );

    setup.controller.dispose();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(getClientSecret).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
    expect(states.mock.calls.map(([event]) => event.state)).toEqual(["connecting", "closed"]);
  });

  it("distinguishes recoverable peer disconnect from terminal data-channel close", async () => {
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onTransportState: states }),
    );
    await attempt.ready;

    setup.peer.setConnectionState("disconnected");
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "disconnected",
    });
    expect(setup.track.stop).not.toHaveBeenCalled();

    setup.channel.closeFromRemote();
    expect(states).toHaveBeenLastCalledWith({ generation: attempt.generation, state: "closed" });
    expect(setup.track.stop).toHaveBeenCalledOnce();
  });

  it("stops media when disposal lands between stage resolution and ownership", async () => {
    const media = deferred<MediaStream>();
    const mediaRequested = deferred<void>();
    const track = new FakeTrack();
    const stream = new FakeStream([track]);
    const setup = harness({
      stream,
      getUserMedia: async () => {
        mediaRequested.resolve();
        return media.promise;
      },
    });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    await mediaRequested.promise;
    void media.promise.then(() => setup.controller.dispose());

    media.resolve(stream as unknown as MediaStream);

    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(setup.createPeerConnection).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("closes a peer exactly once when data-channel creation throws", async () => {
    const channel = new FakeDataChannel();
    const peer = new FakePeerConnection(
      channel,
      undefined,
      new Error("data channel construction failed"),
    );
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));

    await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_failed" });
    setup.controller.dispose();

    expect(setup.track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(channel.close).not.toHaveBeenCalled();
    expect(setup.fetch).not.toHaveBeenCalled();
  });

  it("posts the exact SDP offer with the short-lived credential", async () => {
    const setup = harness();
    const audio = new FakeAudioElement();
    let suppliedSignal: AbortSignal | undefined;
    const attempt = setup.controller.connect(
      connectInput(audio, {
        getClientSecret: async (signal) => {
          suppliedSignal = signal;
          return clientSecret("ek_exact_secret");
        },
      }),
    );

    await attempt.ready;

    expect(setup.getUserMedia).toHaveBeenCalledWith(REALTIME_MEDIA_CONSTRAINTS);
    expect(setup.peer.createOffer).toHaveBeenCalledTimes(1);
    expect(setup.peer.setLocalDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "offer-sdp",
    });
    expect(setup.fetch).toHaveBeenCalledWith(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      body: "offer-sdp",
      headers: {
        Authorization: "Bearer ek_exact_secret",
        "Content-Type": "application/sdp",
      },
      signal: suppliedSignal,
    });
    expect(setup.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp",
    });
    expect(setup.peer.channel).toBe(setup.channel);
    setup.controller.dispose();
  });

  it("waits for remote SDP when the data channel opens first", async () => {
    const remoteDescriptionGate = deferred<void>();
    const channel = new FakeDataChannel("open");
    const peer = new FakePeerConnection(channel, remoteDescriptionGate);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    let ready = false;
    void attempt.ready.then(() => {
      ready = true;
    });

    await peer.remoteDescriptionStarted.promise;
    expect(ready).toBe(false);
    remoteDescriptionGate.resolve();
    await attempt.ready;
    expect(ready).toBe(true);
    setup.controller.dispose();
  });

  it("waits for the data channel when remote SDP is ready first", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    let ready = false;
    void attempt.ready.then(() => {
      ready = true;
    });

    await peer.remoteDescriptionFinished.promise;
    expect(ready).toBe(false);
    channel.open();
    await attempt.ready;
    expect(ready).toBe(true);
    setup.controller.dispose();
  });

  it("does not time the user microphone permission prompt", async () => {
    const media = deferred<MediaStream>();
    const setup = harness({ getUserMedia: async () => media.promise });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));

    await vi.waitFor(() => expect(setup.getUserMedia).toHaveBeenCalledOnce());
    expect(setup.scheduled.size).toBe(0);

    setup.controller.dispose();
    await expect(attempt.ready).rejects.toMatchObject({ reason: "aborted" });
  });

  it("times out a stalled SDP request after media permission resolves", async () => {
    const fetchStarted = deferred<AbortSignal>();
    const fetchResult = deferred<Response>();
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({
      fetch: async (_input, init) => {
        fetchStarted.resolve(init?.signal as AbortSignal);
        return fetchResult.promise;
      },
    });
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onTransportState: states }),
    );
    const signal = await fetchStarted.promise;

    expect(
      [...setup.scheduled.values()].some(
        (task) => task.delayMs === REALTIME_NEGOTIATION_TIMEOUT_MS,
      ),
    ).toBe(true);
    setup.runScheduled(REALTIME_NEGOTIATION_TIMEOUT_MS);

    await expect(attempt.ready).rejects.toMatchObject({
      reason: "negotiation_timeout",
      message: "The voice connection timed out while starting.",
    });
    expect(signal.aborted).toBe(true);
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "failed",
      error: expect.objectContaining({ reason: "negotiation_timeout" }),
    });

    fetchResult.resolve(new Response("late-answer-sdp"));
    await flushPromises();
    expect(setup.peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("times out when the negotiated data channel never opens", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    await peer.remoteDescriptionFinished.promise;

    setup.runScheduled(REALTIME_NEGOTIATION_TIMEOUT_MS);

    await expect(attempt.ready).rejects.toMatchObject({ reason: "negotiation_timeout" });
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("rejects when the peer fails before the session becomes ready", async () => {
    const remoteDescriptionGate = deferred<void>();
    const channel = new FakeDataChannel("open");
    const peer = new FakePeerConnection(channel, remoteDescriptionGate);
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onTransportState: states }),
    );
    await peer.remoteDescriptionStarted.promise;

    peer.setConnectionState("failed");

    await expect(attempt.ready).rejects.toMatchObject({ reason: "connection_failed" });
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "failed",
      error: expect.objectContaining({ reason: "connection_failed" }),
    });
    expect(states.mock.calls.some(([event]) => event.state === "connected")).toBe(false);
    remoteDescriptionGate.resolve();
    await peer.remoteDescriptionFinished.promise;
  });

  it("rechecks a closed peer immediately before declaring readiness", async () => {
    const channel = new FakeDataChannel("connecting");
    const peer = new FakePeerConnection(channel);
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    await peer.remoteDescriptionFinished.promise;

    peer.connectionState = "closed";
    channel.open();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "connection_failed" });
  });

  it("keeps a data-channel error terminal after open but before remote SDP", async () => {
    const remoteDescriptionGate = deferred<void>();
    const channel = new FakeDataChannel("open");
    const peer = new FakePeerConnection(channel, remoteDescriptionGate);
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({ channel, peer });
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onTransportState: states }),
    );
    await peer.remoteDescriptionStarted.promise;

    channel.error();

    await expect(attempt.ready).rejects.toMatchObject({ reason: "data_channel_failed" });
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "failed",
      error: expect.objectContaining({ reason: "data_channel_failed" }),
    });
    expect(states.mock.calls.some(([event]) => event.state === "connected")).toBe(false);
    remoteDescriptionGate.resolve();
    await peer.remoteDescriptionFinished.promise;
  });

  it("stops media that arrives after its generation is superseded", async () => {
    const staleMedia = deferred<MediaStream>();
    const staleRequestStarted = deferred<void>();
    const staleTrackStopped = deferred<void>();
    const staleTrack = new FakeTrack(() => staleTrackStopped.resolve());
    const currentTrack = new FakeTrack();
    const currentStream = new FakeStream([currentTrack]);
    let mediaRequest = 0;
    const setup = harness({
      stream: currentStream,
      getUserMedia: async () => {
        mediaRequest += 1;
        if (mediaRequest === 1) {
          staleRequestStarted.resolve();
          return staleMedia.promise;
        }
        return currentStream as unknown as MediaStream;
      },
    });

    const staleAttempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    await staleRequestStarted.promise;
    const currentAttempt = setup.controller.connect(connectInput(new FakeAudioElement()));

    await expect(staleAttempt.ready).rejects.toMatchObject({ reason: "aborted" });
    await currentAttempt.ready;
    staleMedia.resolve(new FakeStream([staleTrack]) as unknown as MediaStream);
    await staleTrackStopped.promise;

    expect(staleTrack.stop).toHaveBeenCalledTimes(1);
    expect(currentTrack.stop).not.toHaveBeenCalled();
    setup.controller.dispose();
  });

  it("ignores events retained from an older data-channel generation", async () => {
    const channelA = new FakeDataChannel();
    const channelB = new FakeDataChannel();
    const peerA = new FakePeerConnection(channelA);
    const peerB = new FakePeerConnection(channelB);
    const peers = [peerA, peerB];
    const trackA = new FakeTrack();
    const trackB = new FakeTrack();
    const streams = [new FakeStream([trackA]), new FakeStream([trackB])];
    let streamIndex = 0;
    let peerIndex = 0;
    const onOldEvent = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const onCurrentEvent = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const controller = createRealtimeSessionController({
      isSecureContext: () => true,
      getMediaDevices: () =>
        ({
          getUserMedia: async () => streams[streamIndex++] as unknown as MediaStream,
        }) as Pick<MediaDevices, "getUserMedia">,
      createPeerConnection: () => peers[peerIndex++] as unknown as RTCPeerConnection,
      fetch: async () => new Response("answer-sdp"),
      nowEpochMs: () => 1_000_000,
    });

    const first = controller.connect(
      connectInput(new FakeAudioElement(), { onServerEvent: onOldEvent }),
    );
    await first.ready;
    const retainedOldHandler = channelA.retainedMessageListeners()[0];
    const second = controller.connect(
      connectInput(new FakeAudioElement(), { onServerEvent: onCurrentEvent }),
    );
    await second.ready;

    const message = {
      data: JSON.stringify({
        event_id: "session-event",
        type: "session.created",
        session: { id: "session-1" },
      }),
    };
    retainedOldHandler?.(message);
    channelB.message(message.data);

    expect(onOldEvent).not.toHaveBeenCalled();
    expect(onCurrentEvent).toHaveBeenCalledWith({
      generation: second.generation,
      event: expect.objectContaining({ type: "session.created" }),
    });
    expect(trackA.stop).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("emits canonical calls and sends a batch of tool results before one continuation", async () => {
    const setup = harness();
    const onFunctionCalls = vi.fn<(event: RealtimeFunctionCallEnvelope) => void>();
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onFunctionCalls }),
    );
    await attempt.ready;

    setup.channel.message(
      JSON.stringify({
        event_id: "done-event",
        type: "response.done",
        response: {
          id: "response-1",
          status: "completed",
          output: [
            {
              id: "call-item",
              type: "function_call",
              call_id: "call-1",
              name: "open_thread",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
      }),
    );
    expect(onFunctionCalls).toHaveBeenCalledWith({
      generation: attempt.generation,
      calls: [
        {
          itemId: "call-item",
          callId: "call-1",
          name: "open_thread",
          arguments: "{}",
        },
      ],
    });

    setup.controller.sendSessionUpdate({
      type: "realtime",
      instructions: "Keep the user informed.",
    });
    setup.controller.sendToolOutputs({
      outputs: [
        { eventId: "output-1", callId: "call-1", output: { threadId: "thread-1" } },
        { eventId: "output-2", callId: "call-2", output: "Second result" },
      ],
      responseCreateEventId: "continue-1",
    });

    expect(setup.channel.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "session.update",
        session: { type: "realtime", instructions: "Keep the user informed." },
      },
      {
        event_id: "output-1",
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: '{"threadId":"thread-1"}',
        },
      },
      {
        event_id: "output-2",
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-2",
          output: "Second result",
        },
      },
      { event_id: "continue-1", type: "response.create" },
    ]);
    expect(
      setup.channel.sent
        .map((message) => JSON.parse(message) as { readonly type: string })
        .filter((event) => event.type === "response.create"),
    ).toHaveLength(1);
    setup.controller.dispose();
  });

  it("does not emit tool calls when the server-event callback disposes the generation", async () => {
    const setup = harness();
    const onServerEvent = vi.fn((_event: RealtimeServerEventEnvelope) => {
      setup.controller.dispose();
    });
    const onFunctionCalls = vi.fn<(event: RealtimeFunctionCallEnvelope) => void>();
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onServerEvent, onFunctionCalls }),
    );
    await attempt.ready;

    setup.channel.message(
      JSON.stringify({
        event_id: "done-event",
        type: "response.done",
        response: {
          id: "response-1",
          status: "completed",
          output: [
            {
              id: "call-item",
              type: "function_call",
              call_id: "call-1",
              name: "open_thread",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
      }),
    );

    expect(onServerEvent).toHaveBeenCalledTimes(1);
    expect(onFunctionCalls).not.toHaveBeenCalled();
    expect(setup.track.stop).toHaveBeenCalledTimes(1);
    expect(setup.channel.close).toHaveBeenCalledTimes(1);
    expect(setup.peer.close).toHaveBeenCalledTimes(1);
  });

  it("serializes every tool result before sending any part of a batch", async () => {
    const setup = harness();
    const attempt = setup.controller.connect(connectInput(new FakeAudioElement()));
    await attempt.ready;
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      setup.controller.sendToolOutputs({
        outputs: [
          { eventId: "output-1", callId: "call-1", output: { ok: true } },
          { eventId: "output-2", callId: "call-2", output: circular },
        ],
        responseCreateEventId: "continue-1",
      }),
    ).toThrow(expect.objectContaining({ reason: "serialization_failed" }));
    expect(setup.channel.sent).toEqual([]);
    setup.controller.dispose();
  });

  it("mutes tracks and disposes local, remote, channel, peer, and audio exactly once", async () => {
    const setup = harness();
    const audio = new FakeAudioElement();
    const remoteTrack = new FakeTrack();
    const remoteStream = new FakeStream([remoteTrack]);
    const attempt = setup.controller.connect(connectInput(audio));
    await attempt.ready;
    setup.peer.emitTrack(remoteTrack, remoteStream);

    setup.controller.setMuted(true);
    expect(setup.track.enabled).toBe(false);
    setup.controller.setMuted(false);
    expect(setup.track.enabled).toBe(true);

    setup.controller.dispose();
    setup.controller.dispose();

    expect(setup.track.stop).toHaveBeenCalledTimes(1);
    expect(remoteTrack.stop).toHaveBeenCalledTimes(1);
    expect(setup.channel.close).toHaveBeenCalledTimes(1);
    expect(setup.peer.close).toHaveBeenCalledTimes(1);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
  });

  it("fails setup with a redacted error when remote audio cannot play before readiness", async () => {
    const remoteDescriptionGate = deferred<void>();
    const channel = new FakeDataChannel("open");
    const peer = new FakePeerConnection(channel, remoteDescriptionGate);
    const setup = harness({ channel, peer });
    const audio = new FakeAudioElement();
    audio.play.mockRejectedValueOnce(new Error("autoplay raw browser detail"));
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const attempt = setup.controller.connect(connectInput(audio, { onTransportState: states }));
    await peer.remoteDescriptionStarted.promise;

    const remoteTrack = new FakeTrack();
    peer.emitTrack(remoteTrack, new FakeStream([remoteTrack]));

    await expect(attempt.ready).rejects.toMatchObject({
      reason: "audio_playback_failed",
      message: "T3 Code could not play voice audio.",
    });
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "failed",
      error: expect.objectContaining({ reason: "audio_playback_failed" }),
    });
    expect(JSON.stringify(states.mock.calls)).not.toContain("raw browser detail");
    expect(remoteTrack.stop).toHaveBeenCalledOnce();

    remoteDescriptionGate.resolve();
    await peer.remoteDescriptionFinished.promise;
  });

  it("terminates a ready session when later remote audio playback fails", async () => {
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const audio = new FakeAudioElement();
    const attempt = setup.controller.connect(connectInput(audio, { onTransportState: states }));
    await attempt.ready;
    audio.play.mockRejectedValueOnce(new Error("late autoplay raw detail"));

    const remoteTrack = new FakeTrack();
    setup.peer.emitTrack(remoteTrack, new FakeStream([remoteTrack]));
    await vi.waitFor(() =>
      expect(states).toHaveBeenLastCalledWith({
        generation: attempt.generation,
        state: "failed",
        error: expect.objectContaining({ reason: "audio_playback_failed" }),
      }),
    );

    expect(JSON.stringify(states.mock.calls)).not.toContain("late autoplay raw detail");
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
    expect(setup.channel.close).toHaveBeenCalledOnce();
    expect(setup.peer.close).toHaveBeenCalledOnce();
  });

  it("aborts in-flight negotiation and never exposes provider or credential errors", async () => {
    const fetchStarted = deferred<AbortSignal>();
    const fetchResult = deferred<Response>();
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness({
      fetch: async (_input, init) => {
        fetchStarted.resolve(init?.signal as AbortSignal);
        return fetchResult.promise;
      },
    });
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), { onTransportState: states }),
    );
    const signal = await fetchStarted.promise;

    setup.controller.dispose();
    expect(signal.aborted).toBe(true);
    expect(setup.scheduled.size).toBe(0);
    await expect(attempt.ready).rejects.toMatchObject({
      name: "RealtimeSessionError",
      reason: "aborted",
      message: "The voice connection was cancelled.",
    });
    fetchResult.reject(new Error("upstream leaked ek_short_lived"));
    await flushPromises();
    expect(JSON.stringify(states.mock.calls)).not.toContain("ek_short_lived");
    expect(setup.peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("redacts client-secret failures before notifying consumers", async () => {
    const states = vi.fn<(event: RealtimeTransportStateEnvelope) => void>();
    const setup = harness();
    const attempt = setup.controller.connect(
      connectInput(new FakeAudioElement(), {
        getClientSecret: async () => {
          throw new Error("credential ek_do_not_leak");
        },
        onTransportState: states,
      }),
    );

    await expect(attempt.ready).rejects.toEqual(
      expect.objectContaining<Partial<RealtimeSessionError>>({
        reason: "client_secret_failed",
        message: "T3 Code could not start a voice session.",
      }),
    );
    expect(JSON.stringify(states.mock.calls)).not.toContain("ek_do_not_leak");
    expect(states).toHaveBeenLastCalledWith({
      generation: attempt.generation,
      state: "failed",
      error: expect.objectContaining({ reason: "client_secret_failed" }),
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const reactNativeMocks = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  const remove = vi.fn();
  return {
    listeners,
    remove,
    AppState: {
      currentState: "active",
      addEventListener: vi.fn((_type: "change", listener: (state: string) => void) => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
            remove();
          },
        };
      }),
    },
  };
});

const webRtcMocks = vi.hoisted(() => {
  class NativeTrack {
    enabled = true;
    readonly kind: string;
    readonly stop = vi.fn();

    constructor(kind = "audio") {
      this.kind = kind;
    }
  }

  class NativeStream {
    readonly track = new NativeTrack();
    readonly release = vi.fn();

    getTracks() {
      return [this.track];
    }

    getAudioTracks() {
      return [this.track];
    }
  }

  class NativeChannel {
    readyState = "open";
    readonly sent: string[] = [];
    readonly close = vi.fn(() => {
      this.readyState = "closed";
    });
    readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    addEventListener(type: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string) {
      this.sent.push(data);
    }

    emit(type: string, event: unknown = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  class NativePeer {
    connectionState = "new";
    readonly channel = new NativeChannel();
    readonly labels: string[] = [];
    readonly localDescriptions: unknown[] = [];
    readonly remoteDescriptions: unknown[] = [];
    readonly addedTracks: unknown[] = [];
    readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    readonly close = vi.fn(() => {
      this.connectionState = "closed";
    });

    createDataChannel(label: string) {
      this.labels.push(label);
      return this.channel;
    }

    addTrack(track: unknown, stream: unknown) {
      this.addedTracks.push({ track, stream });
      return { track };
    }

    async createOffer() {
      return { type: "offer", sdp: "native-offer-sdp" };
    }

    async setLocalDescription(description: unknown) {
      this.localDescriptions.push(description);
    }

    async setRemoteDescription(description: unknown) {
      this.remoteDescriptions.push(description);
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }

    getSenders() {
      return this.addedTracks.map((entry) => entry as { track: unknown });
    }

    getReceivers() {
      return [];
    }

    emit(type: string, event: unknown = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const stream = new NativeStream();
  const peers: NativePeer[] = [];
  const permissionRequest = vi.fn(async () => true);
  const getUserMedia = vi.fn(async () => stream);
  class RTCPeerConnection extends NativePeer {
    constructor() {
      super();
      peers.push(this);
    }
  }
  return {
    NativeTrack,
    NativeStream,
    stream,
    peers,
    permissionRequest,
    getUserMedia,
    RTCPeerConnection,
  };
});

const expoMocks = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | undefined;
  const remove = vi.fn();
  const nativeModule = {
    start: vi.fn(() => 1),
    stop: vi.fn((_activationToken: number) => undefined),
    addListener: vi.fn((_name: string, nextListener: (event: unknown) => void) => {
      listener = nextListener;
      return { remove };
    }),
  };
  return {
    nativeModule,
    remove,
    emit(event: unknown) {
      listener?.(event);
    },
  };
});

vi.mock("react-native", () => ({ AppState: reactNativeMocks.AppState }));
vi.mock("react-native-webrtc", () => ({
  MediaStream: webRtcMocks.NativeStream,
  MediaStreamTrack: webRtcMocks.NativeTrack,
  RTCPeerConnection: webRtcMocks.RTCPeerConnection,
  mediaDevices: { getUserMedia: webRtcMocks.getUserMedia },
  permissions: { request: webRtcMocks.permissionRequest },
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => expoMocks.nativeModule,
}));

import type { RealtimeServerEventEnvelope } from "@t3tools/client-runtime/voice/realtime-transport";

import {
  MOBILE_REALTIME_MEDIA_CONSTRAINTS,
  OPENAI_REALTIME_CALLS_URL,
  createMobileRealtimeSessionController,
  createMobileRealtimeSessionDependencies,
} from "./realtimeSession";

describe("mobile Realtime native adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webRtcMocks.peers.length = 0;
    webRtcMocks.stream.track.enabled = true;
    reactNativeMocks.AppState.currentState = "active";
    reactNativeMocks.listeners.clear();
  });

  it("binds permission, media, WebRTC, AppState, audio-session, and fetch exactly", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return "native-answer-sdp";
      },
    }));
    const controller = createMobileRealtimeSessionController({ fetch });
    const attempt = controller.connect({
      getClientSecret: async () => ({
        clientSecret: "ek_native_adapter",
        expiresAt: Math.ceil(Date.now() / 1_000) + 60,
        sessionId: "native-session",
      }),
    });

    await attempt.ready;

    const peer = webRtcMocks.peers[0]!;
    expect(webRtcMocks.permissionRequest).toHaveBeenCalledWith({ name: "microphone" });
    expect(webRtcMocks.getUserMedia).toHaveBeenCalledWith(MOBILE_REALTIME_MEDIA_CONSTRAINTS);
    expect(expoMocks.nativeModule.start).toHaveBeenCalledOnce();
    expect(peer.labels).toEqual(["oai-events"]);
    expect(peer.addedTracks).toEqual([
      { track: webRtcMocks.stream.track, stream: webRtcMocks.stream },
    ]);
    expect(peer.localDescriptions).toEqual([{ type: "offer", sdp: "native-offer-sdp" }]);
    expect(fetch).toHaveBeenCalledWith(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      body: "native-offer-sdp",
      headers: {
        Authorization: "Bearer ek_native_adapter",
        "Content-Type": "application/sdp",
      },
      signal: expect.any(AbortSignal),
    });
    expect(peer.remoteDescriptions).toEqual([{ type: "answer", sdp: "native-answer-sdp" }]);

    controller.dispose();
    expect(webRtcMocks.stream.track.stop).toHaveBeenCalledOnce();
    expect(webRtcMocks.stream.release).toHaveBeenCalledWith(true);
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(expoMocks.nativeModule.stop).toHaveBeenCalledOnce();
    expect(expoMocks.nativeModule.stop).toHaveBeenCalledWith(1);
    expect(reactNativeMocks.remove).toHaveBeenCalledOnce();
    expect(expoMocks.remove).toHaveBeenCalledOnce();
  });

  it("adapts native channel messages and streamless remote audio without a view", async () => {
    const events = vi.fn<(event: RealtimeServerEventEnvelope) => void>();
    const controller = createMobileRealtimeSessionController({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => "native-answer-sdp",
      }),
    });
    const attempt = controller.connect({
      getClientSecret: async () => ({
        clientSecret: "ek_native_adapter",
        expiresAt: Math.ceil(Date.now() / 1_000) + 60,
        sessionId: "native-session",
      }),
      onServerEvent: events,
    });
    await attempt.ready;
    const peer = webRtcMocks.peers[0]!;
    const remoteTrack = new webRtcMocks.NativeTrack();

    peer.channel.emit("message", {
      data: JSON.stringify({
        event_id: "session-created-native",
        type: "session.created",
        session: { id: "native-session" },
      }),
    });
    peer.emit("track", { track: remoteTrack, streams: [] });

    expect(events).toHaveBeenCalledWith({
      generation: attempt.generation,
      event: {
        event_id: "session-created-native",
        type: "session.created",
        session: { id: "native-session" },
      },
    });
    expect(remoteTrack.stop).not.toHaveBeenCalled();
    controller.dispose();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
  });

  it("maps native interruption and AppState changes to one terminal teardown", async () => {
    const dependencies = createMobileRealtimeSessionDependencies();
    const controller = createMobileRealtimeSessionController({
      ...dependencies,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => "native-answer-sdp",
      }),
    });
    const states = vi.fn();
    const attempt = controller.connect({
      getClientSecret: async () => ({
        clientSecret: "ek_native_adapter",
        expiresAt: Math.ceil(Date.now() / 1_000) + 60,
        sessionId: "native-session",
      }),
      onTransportState: states,
    });
    await attempt.ready;

    expoMocks.emit({ kind: "interruption", activationToken: 1 });
    for (const listener of reactNativeMocks.listeners) listener("background");

    expect(states.mock.calls.map(([event]) => event.state)).toEqual([
      "connecting",
      "connected",
      "closed",
    ]);
    expect(expoMocks.nativeModule.stop).toHaveBeenCalledOnce();
  });
});

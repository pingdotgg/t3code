import { AppState } from "react-native";
import {
  RTCPeerConnection,
  mediaDevices,
  permissions,
  type MediaStream,
  type MediaStreamTrack,
} from "react-native-webrtc";

import {
  createMobileRealtimeSessionControllerCore,
  type MobileRealtimeDataChannel,
  type MobileRealtimeDataChannelEvent,
  type MobileRealtimeDataChannelEventType,
  type MobileRealtimeMediaStream,
  type MobileRealtimeMediaTrack,
  type MobileRealtimePeerConnection,
  type MobileRealtimePeerEventType,
  type MobileRealtimeSessionDependencies,
  type MobileRealtimeTrackEvent,
} from "./realtimeSessionCore";
import { createNativeVoiceAudioSession } from "./voiceAudioSession";

export {
  MOBILE_REALTIME_MEDIA_CONSTRAINTS,
  MOBILE_REALTIME_NEGOTIATION_TIMEOUT_MS,
  OPENAI_REALTIME_CALLS_URL,
  type MobileRealtimeSessionDependencies,
} from "./realtimeSessionCore";

type DataChannelListener = (event: MobileRealtimeDataChannelEvent) => void;
type PeerListener = (event: MobileRealtimeTrackEvent | undefined) => void;

interface NativeDataChannelEventTarget {
  readonly addEventListener: (
    type: MobileRealtimeDataChannelEventType,
    listener: (event: { readonly data?: unknown }) => void,
  ) => void;
  readonly removeEventListener: (
    type: MobileRealtimeDataChannelEventType,
    listener: (event: { readonly data?: unknown }) => void,
  ) => void;
}

interface NativePeerEventTarget {
  readonly addEventListener: (
    type: MobileRealtimePeerEventType,
    listener: (event: {
      readonly track?: MediaStreamTrack | null;
      readonly streams?: ReadonlyArray<MediaStream>;
    }) => void,
  ) => void;
  readonly removeEventListener: (
    type: MobileRealtimePeerEventType,
    listener: (event: {
      readonly track?: MediaStreamTrack | null;
      readonly streams?: ReadonlyArray<MediaStream>;
    }) => void,
  ) => void;
}

function hasNativeDataChannelEventTarget(value: object): value is NativeDataChannelEventTarget {
  return (
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

function hasNativePeerEventTarget(value: object): value is NativePeerEventTarget {
  return (
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

function rememberRemoval<TListener, TEvent extends string>(
  removals: Map<TListener, Map<TEvent, () => void>>,
  listener: TListener,
  type: TEvent,
  remove: () => void,
): void {
  const byType = removals.get(listener) ?? new Map<TEvent, () => void>();
  byType.get(type)?.();
  byType.set(type, remove);
  removals.set(listener, byType);
}

function takeRemoval<TListener, TEvent extends string>(
  removals: Map<TListener, Map<TEvent, () => void>>,
  listener: TListener,
  type: TEvent,
): void {
  const byType = removals.get(listener);
  const remove = byType?.get(type);
  if (!remove || !byType) return;
  byType.delete(type);
  if (byType.size === 0) removals.delete(listener);
  remove();
}

function adaptDataChannel(
  nativeChannel: ReturnType<RTCPeerConnection["createDataChannel"]>,
): MobileRealtimeDataChannel {
  if (!hasNativeDataChannelEventTarget(nativeChannel)) {
    throw new Error("Native data channel events are unavailable.");
  }
  const nativeEvents = nativeChannel;
  const removals = new Map<
    DataChannelListener,
    Map<MobileRealtimeDataChannelEventType, () => void>
  >();
  return {
    get readyState() {
      return nativeChannel.readyState;
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        const nativeListener = (event: { readonly data?: unknown }) =>
          listener({ data: event.data });
        nativeEvents.addEventListener("message", nativeListener);
        rememberRemoval(removals, listener, type, () =>
          nativeEvents.removeEventListener("message", nativeListener),
        );
        return;
      }
      const nativeListener = () => listener({});
      nativeEvents.addEventListener(type, nativeListener);
      rememberRemoval(removals, listener, type, () =>
        nativeEvents.removeEventListener(type, nativeListener),
      );
    },
    removeEventListener: (type, listener) => takeRemoval(removals, listener, type),
    send: (data) => nativeChannel.send(data),
    close: () => nativeChannel.close(),
  };
}

function adaptPeerConnection(nativePeer: RTCPeerConnection): MobileRealtimePeerConnection {
  if (!hasNativePeerEventTarget(nativePeer)) {
    throw new Error("Native peer events are unavailable.");
  }
  const nativeEvents = nativePeer;
  const removals = new Map<PeerListener, Map<MobileRealtimePeerEventType, () => void>>();
  return {
    get connectionState() {
      return nativePeer.connectionState;
    },
    createDataChannel: (label) => adaptDataChannel(nativePeer.createDataChannel(label)),
    addTrack: (track, stream) =>
      nativePeer.addTrack(track as MediaStreamTrack, stream as MediaStream),
    createOffer: async () => {
      const offer = await nativePeer.createOffer();
      return { type: "offer", sdp: offer.sdp };
    },
    setLocalDescription: (description) => {
      if (description.sdp === undefined) return Promise.reject(new Error("Missing offer SDP."));
      return nativePeer.setLocalDescription({ type: "offer", sdp: description.sdp });
    },
    setRemoteDescription: (description) => nativePeer.setRemoteDescription(description),
    addEventListener: (type, listener) => {
      if (type === "track") {
        const nativeListener = (event: {
          readonly track?: MediaStreamTrack | null;
          readonly streams?: ReadonlyArray<MediaStream>;
        }) => listener({ track: event.track ?? null, streams: event.streams ?? [] });
        nativeEvents.addEventListener("track", nativeListener);
        rememberRemoval(removals, listener, type, () =>
          nativeEvents.removeEventListener("track", nativeListener),
        );
        return;
      }
      const nativeListener = () => listener(undefined);
      nativeEvents.addEventListener("connectionstatechange", nativeListener);
      rememberRemoval(removals, listener, type, () =>
        nativeEvents.removeEventListener("connectionstatechange", nativeListener),
      );
    },
    removeEventListener: (type, listener) => takeRemoval(removals, listener, type),
    getSenders: () => nativePeer.getSenders().map(({ track }) => ({ track })),
    getReceivers: () => nativePeer.getReceivers().map(({ track }) => ({ track })),
    close: () => nativePeer.close(),
  };
}

export function createMobileRealtimeSessionDependencies(): MobileRealtimeSessionDependencies {
  return {
    getAppState: () => AppState.currentState,
    subscribeToAppState: (listener) => {
      const subscription = AppState.addEventListener("change", listener);
      return () => subscription.remove();
    },
    // This explicit phase lets the controller wait for iOS to return active before
    // capture. getUserMedia repeats an already-granted check inside the library.
    requestMicrophonePermission: async () =>
      (await permissions.request({ name: "microphone" })) === true,
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => adaptPeerConnection(new RTCPeerConnection()),
    audioSession: createNativeVoiceAudioSession(),
    fetch: async (url, init) =>
      fetch(url, {
        method: init.method,
        body: init.body,
        headers: { ...init.headers },
        signal: init.signal,
      }),
    nowEpochMs: Date.now,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelScheduled: (handle) => clearTimeout(handle),
  };
}

export function createMobileRealtimeSessionController(
  overrides: Partial<MobileRealtimeSessionDependencies> = {},
) {
  return createMobileRealtimeSessionControllerCore({
    ...createMobileRealtimeSessionDependencies(),
    ...overrides,
  });
}

export type { MobileRealtimeMediaStream, MobileRealtimeMediaTrack, MobileRealtimePeerConnection };

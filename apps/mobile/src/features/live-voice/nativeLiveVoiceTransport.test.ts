import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rtc = vi.hoisted(() => {
  const peerListeners = new Map<string, () => void>();
  const channelListeners = new Map<string, (event: { data?: unknown }) => void>();
  const track = { enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], release: vi.fn() };
  const channel = {
    close: vi.fn(),
    set onopen(handler: (event: { data?: unknown }) => void) {
      channelListeners.set("open", handler);
    },
    set onclose(handler: (event: { data?: unknown }) => void) {
      channelListeners.set("close", handler);
    },
    set onerror(handler: (event: { data?: unknown }) => void) {
      channelListeners.set("error", handler);
    },
    set onmessage(handler: (event: { data?: unknown }) => void) {
      channelListeners.set("message", handler);
    },
    addEventListener: vi.fn((name: string, handler: (event: { data?: unknown }) => void) => {
      channelListeners.set(name, handler);
    }),
  };
  const peer = {
    connectionState: "new",
    iceGatheringState: "complete",
    localDescription: { sdp: "final-offer-with-candidates" },
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => channel),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "initial-offer" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    addEventListener: vi.fn((name: string, handler: () => void) => {
      peerListeners.set(name, handler);
    }),
    removeEventListener: vi.fn((name: string) => {
      peerListeners.delete(name);
    }),
    close: vi.fn(),
    set onconnectionstatechange(handler: () => void) {
      peerListeners.set("connectionstatechange", handler);
    },
    set onicegatheringstatechange(handler: (() => void) | null) {
      if (handler) peerListeners.set("icegatheringstatechange", handler);
      else peerListeners.delete("icegatheringstatechange");
    },
  };
  const getUserMedia = vi.fn(async () => stream);
  return { track, stream, channel, peer, getUserMedia, peerListeners, channelListeners };
});

vi.mock("react-native-webrtc", () => ({
  mediaDevices: { getUserMedia: rtc.getUserMedia },
  RTCPeerConnection: function () {
    return rtc.peer;
  },
}));

import { createNativeLiveVoiceTransport } from "./nativeLiveVoiceTransport";
import { isLiveVoiceMicrophoneReserved } from "./microphoneReservation";

function setup() {
  const callbacks = { onEvent: vi.fn(), onConnectionState: vi.fn() };
  return { callbacks, transport: createNativeLiveVoiceTransport(callbacks) };
}

describe("native live voice transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rtc.peerListeners.clear();
    rtc.channelListeners.clear();
    rtc.peer.iceGatheringState = "complete";
    rtc.track.enabled = true;
    rtc.getUserMedia.mockResolvedValue(rtc.stream);
  });

  it("negotiates audio only using the final gathered SDP and releases capture once", async () => {
    const { transport } = setup();
    transport.setMuted(true);
    expect(await transport.createOffer()).toBe("final-offer-with-candidates");
    expect(rtc.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(rtc.track.enabled).toBe(false);
    await transport.acceptAnswer("remote-answer");
    expect(rtc.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "remote-answer",
    });
    transport.setMuted(false);
    expect(rtc.track.enabled).toBe(true);
    transport.close();
    transport.close();
    expect(rtc.track.stop).toHaveBeenCalledOnce();
    expect(rtc.stream.release).toHaveBeenCalledOnce();
    expect(rtc.peer.close).toHaveBeenCalledOnce();
  });

  it("waits for ICE gathering and removes its listener after completion", async () => {
    rtc.peer.iceGatheringState = "gathering";
    const { transport } = setup();
    const pending = transport.createOffer();
    await vi.waitFor(() => expect(rtc.peerListeners.has("icegatheringstatechange")).toBe(true));
    rtc.peer.iceGatheringState = "complete";
    rtc.peerListeners.get("icegatheringstatechange")?.();
    expect(await pending).toBe("final-offer-with-candidates");
    expect(rtc.peerListeners.has("icegatheringstatechange")).toBe(false);
    transport.close();
  });

  it("cancels an outstanding ICE wait immediately", async () => {
    rtc.peer.iceGatheringState = "gathering";
    const { transport } = setup();
    const pending = transport.createOffer();
    const rejection = expect(pending).rejects.toThrow("Voice chat ended");
    await vi.waitFor(() => expect(rtc.peerListeners.has("icegatheringstatechange")).toBe(true));
    transport.close();
    await rejection;
    expect(rtc.peerListeners.has("icegatheringstatechange")).toBe(false);
    expect(rtc.stream.release).toHaveBeenCalledOnce();
  });

  it("releases a microphone granted after cancellation without creating a peer", async () => {
    let grant!: (value: typeof rtc.stream) => void;
    rtc.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const { transport } = setup();
    const pending = transport.createOffer();
    const rejection = expect(pending).rejects.toThrow("Voice chat ended");
    await vi.waitFor(() => expect(rtc.getUserMedia).toHaveBeenCalledOnce());
    transport.close();
    expect(isLiveVoiceMicrophoneReserved()).toBe(true);
    const nextThread = setup().transport;
    await expect(nextThread.createOffer()).rejects.toThrow("finishing the previous voice chat");
    expect(rtc.getUserMedia).toHaveBeenCalledOnce();
    grant(rtc.stream);
    await rejection;
    expect(rtc.stream.release).toHaveBeenCalledOnce();
    expect(rtc.peer.addTrack).not.toHaveBeenCalled();
    expect(isLiveVoiceMicrophoneReserved()).toBe(false);
    await nextThread.createOffer();
    nextThread.close();
  });

  it("forwards channel events and ignores them after closing", async () => {
    const { transport, callbacks } = setup();
    await transport.createOffer();
    rtc.channelListeners.get("open")?.({});
    expect(callbacks.onConnectionState).toHaveBeenCalledWith("connected");
    rtc.channelListeners.get("message")?.({ data: '{"type":"session.started"}' });
    expect(callbacks.onEvent).toHaveBeenCalledWith({ type: "session.started" });
    rtc.channelListeners.get("message")?.({ data: "invalid" });
    transport.close();
    rtc.channelListeners.get("message")?.({ data: '{"type":"session.started"}' });
    rtc.channelListeners.get("close")?.({});
    expect(callbacks.onEvent).toHaveBeenCalledOnce();
    expect(callbacks.onConnectionState).toHaveBeenCalledOnce();
  });

  it("releases native capture if offer generation fails", async () => {
    rtc.peer.createOffer.mockRejectedValueOnce(new Error("Native negotiation failed"));
    const { transport } = setup();
    await expect(transport.createOffer()).rejects.toThrow("Native negotiation failed");
    expect(rtc.stream.release).toHaveBeenCalledOnce();
    expect(rtc.peer.close).toHaveBeenCalledOnce();
    expect(isLiveVoiceMicrophoneReserved()).toBe(false);
  });
});

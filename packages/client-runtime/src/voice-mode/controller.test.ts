import { describe, expect, it } from "vite-plus/test";

import {
  appendVoiceCaption,
  finishVoiceCaption,
  VoiceModeController,
  type VoiceMediaStream,
  type VoiceModePlatform,
  type VoicePeerConnection,
  type VoiceSessionHandlers,
} from "./controller.ts";

const target = { environmentId: "env-1", threadId: "thread-1" };

function makeFakePlatform(options: { readonly denyMicrophone?: boolean } = {}) {
  const track = { enabled: true, stopped: false, stop: () => void (track.stopped = true) };
  const microphone: VoiceMediaStream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const listeners = new Map<string, (event: never) => void>();
  const peer = {
    connectionState: "new",
    closed: false,
    remoteSdp: null as string | null,
    dataChannels: [] as string[],
    addTrack: () => undefined,
    createDataChannel: (label: string) => void peer.dataChannels.push(label),
    createOffer: async () => ({ sdp: "v=offer\r\n" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async (description: { sdp: string }) => {
      peer.remoteSdp = description.sdp;
    },
    getStats: async () => ({ forEach: () => undefined }),
    addEventListener: (type: string, listener: (event: never) => void) =>
      void listeners.set(type, listener),
    close: () => void (peer.closed = true),
    connect: () => {
      peer.connectionState = "connected";
      listeners.get("connectionstatechange")?.({} as never);
    },
  };
  const sessions: Array<{
    readonly offerSdp: string;
    readonly handlers: VoiceSessionHandlers;
    cancelled: boolean;
  }> = [];
  const platform: VoiceModePlatform = {
    createPeerConnection: () => peer as unknown as VoicePeerConnection,
    getMicrophone: async () => {
      if (options.denyMicrophone) {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      }
      return microphone;
    },
    playRemoteAudio: () => () => undefined,
    openSession: (input, handlers) => {
      const session = { offerSdp: input.offerSdp, handlers, cancelled: false };
      sessions.push(session);
      return () => void (session.cancelled = true);
    },
  };
  return { platform, peer, track, sessions };
}

async function startConversation() {
  const fake = makeFakePlatform();
  const controller = new VoiceModeController(fake.platform);
  await controller.start(target);
  const session = fake.sessions[0]!;
  return { ...fake, controller, session };
}

describe("VoiceModeController", () => {
  it("negotiates WebRTC through the voice session and activates once both sides are up", async () => {
    const { controller, peer, session } = await startConversation();
    expect(peer.dataChannels).toEqual(["oai-events"]);
    expect(session.offerSdp).toBe("v=offer\r\n");
    expect(controller.getState().phase).toBe("connecting");

    session.handlers.onEvent({ type: "answer", sdp: "v=answer\r\n" });
    await Promise.resolve();
    expect(peer.remoteSdp).toBe("v=answer\r\n");

    session.handlers.onEvent({ type: "started" });
    expect(controller.getState().phase).toBe("connecting");
    peer.connect();
    expect(controller.getState().phase).toBe("active");
    controller.stop();
  });

  it("keeps ephemeral captions and reports why Codex ended the conversation", async () => {
    const { controller, peer, session, track } = await startConversation();
    session.handlers.onEvent({ type: "transcript.delta", role: "user", delta: "run the" });
    session.handlers.onEvent({ type: "transcript.delta", role: "user", delta: " tests" });
    expect(controller.getState().captions).toEqual([
      { role: "user", text: "run the tests", final: false },
    ]);

    session.handlers.onEvent({ type: "closed", reason: "transport_closed" });
    const state = controller.getState();
    expect(state.phase).toBe("idle");
    expect(state.captions).toEqual([]);
    expect(state.endedReason).toBe("transport_closed");
    expect(state.target).toEqual(target);
    expect(peer.closed).toBe(true);
    expect(track.stopped).toBe(true);
  });

  it("ends the server session and releases the microphone when the user stops", async () => {
    const { controller, peer, session, track } = await startConversation();
    controller.toggle(target);
    expect(session.cancelled).toBe(true);
    expect(peer.closed).toBe(true);
    expect(track.stopped).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "idle", endedReason: null, error: null });
  });

  it("mutes by disabling the microphone track", async () => {
    const { controller, track } = await startConversation();
    controller.toggleMuted();
    expect(track.enabled).toBe(false);
    expect(controller.getState().muted).toBe(true);
    controller.toggleMuted();
    expect(track.enabled).toBe(true);
    controller.stop();
  });

  it("explains a denied microphone without opening a session", async () => {
    const fake = makeFakePlatform({ denyMicrophone: true });
    const controller = new VoiceModeController(fake.platform);
    await controller.start(target);
    expect(fake.sessions).toHaveLength(0);
    expect(controller.getState()).toMatchObject({
      phase: "idle",
      error: "Microphone access was denied.",
    });
  });
});

describe("voice captions", () => {
  it("interleaves speakers and settles each with its final text", () => {
    let captions = appendVoiceCaption([], "user", "hello");
    captions = appendVoiceCaption(captions, "assistant", "Hi");
    captions = appendVoiceCaption(captions, "user", " there");
    captions = finishVoiceCaption(captions, "user", "Hello there.");
    expect(captions).toEqual([
      { role: "user", text: "Hello there.", final: true },
      { role: "assistant", text: "Hi", final: false },
    ]);
  });

  it("keeps only the most recent captions", () => {
    let captions = finishVoiceCaption([], "user", "one");
    for (const text of ["two", "three", "four", "five"]) {
      captions = finishVoiceCaption(captions, "assistant", text);
    }
    expect(captions.map((caption) => caption.text)).toEqual(["two", "three", "four", "five"]);
  });
});

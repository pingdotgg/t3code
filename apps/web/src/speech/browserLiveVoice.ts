import * as SecureRandom from "effect/crypto/SecureRandom";
import type { LiveVoiceState } from "@t3tools/contracts";

export type LiveVoicePhase = "idle" | "connecting" | "connected" | "error";
export type LiveVoiceBrowserDependencies = {
  open: (
    sessionId: string,
    voice: string,
    sdp: string,
    signal: AbortSignal,
  ) => Promise<{ sdp: string }>;
  poll: (sessionId: string, revision: number, signal: AbortSignal) => Promise<LiveVoiceState>;
  stop: (sessionId: string) => Promise<void>;
  getMicrophoneId?: () => string | Promise<string>;
  onPhase: (phase: LiveVoicePhase, error: string | null) => void;
  onTranscript: (transcripts: LiveVoiceState["transcripts"]) => void;
};

export class BrowserLiveVoice {
  private abort: AbortController | null = null;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private sessionId: string | null = null;
  private generation = 0;

  constructor(private readonly dependencies: LiveVoiceBrowserDependencies) {}

  stop(notify = true) {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.ontrack = null;
      this.peer.close();
      this.peer = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    const id = this.sessionId;
    this.sessionId = null;
    if (id) void this.dependencies.stop(id).catch(() => undefined);
    if (notify) this.dependencies.onPhase("idle", null);
  }

  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  private fail(error: unknown) {
    this.stop(false);
    this.dependencies.onPhase(
      "error",
      error instanceof Error ? error.message : "Voice could not connect. Try again.",
    );
  }

  async start(voice: string) {
    this.stop(false);
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.dependencies.onTranscript([]);
    this.dependencies.onPhase("connecting", null);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined")
        throw new Error(
          "Live voice needs a browser with microphone access over HTTPS or localhost.",
        );
      const microphone = this.dependencies.getMicrophoneId
        ? await this.dependencies.getMicrophoneId()
        : "";
      if (generation !== this.generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          ...(microphone ? { deviceId: { exact: microphone } } : {}),
        },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = (event) => {
        if (generation !== this.generation) return;
        audio.srcObject = new MediaStream([event.track]);
        void audio.play().catch(() => {
          if (generation === this.generation)
            this.fail(
              new Error("The browser blocked voice playback. End voice and try Start voice again."),
            );
        });
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === "connected") this.dependencies.onPhase("connected", null);
        if (peer.connectionState === "failed" || peer.connectionState === "closed")
          this.fail(new Error("The voice connection ended. Your coding tasks are still in T3."));
      };
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));
      peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", changed);
          abort.signal.removeEventListener("abort", cancelled);
          resolve();
        };
        const changed = () => {
          if (peer.iceGatheringState === "complete") finish();
        };
        const cancelled = () => {
          finish();
          reject(new DOMException("Voice start cancelled", "AbortError"));
        };
        const timeout = setTimeout(finish, 5000);
        peer.addEventListener("icegatheringstatechange", changed);
        abort.signal.addEventListener("abort", cancelled, { once: true });
        changed();
      });
      if (generation !== this.generation) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("The browser could not prepare a voice connection.");
      const id = SecureRandom.uuidV4Unsafe();
      this.sessionId = id;
      const answer = await this.dependencies.open(id, voice, sdp, abort.signal);
      if (generation !== this.generation) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      let revision = -1;
      while (generation === this.generation) {
        const state = await this.dependencies.poll(id, revision, abort.signal);
        if (generation !== this.generation) return;
        revision = state.revision;
        this.dependencies.onTranscript(state.transcripts);
        if (state.phase !== "connected") {
          this.stop(false);
          this.dependencies.onPhase(state.error ? "error" : "idle", state.error);
          return;
        }
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }
}

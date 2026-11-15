import { speechTextChunks } from "./text.ts";

type Phase = "idle" | "loading" | "playing" | "paused" | "error";
type Snapshot = {
  readonly owner: string | null;
  readonly phase: Phase;
  readonly error: string | null;
};

export type SpeechAudioPlayer = {
  readonly play: (audio: Uint8Array, signal: AbortSignal, onPlaying: () => void) => Promise<void>;
  readonly pause: () => void;
  readonly resume: () => Promise<void>;
};

export class VoiceOutputController {
  private snapshot: Snapshot = { owner: null, phase: "idle", error: null };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;

  private readonly player: SpeechAudioPlayer;

  constructor(player: SpeechAudioPlayer) {
    this.player = player;
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  readonly stop = () => {
    this.request?.abort();
    this.request = null;
    this.publish({ owner: null, phase: "idle", error: null });
  };

  async start(
    owner: string,
    markdown: string,
    synthesize: (text: string, signal: AbortSignal) => Promise<Uint8Array>,
  ) {
    this.stop();
    const request = new AbortController();
    this.request = request;
    this.publish({ owner, phase: "loading", error: null });
    try {
      const chunks = speechTextChunks(markdown);
      if (!chunks.length) throw new Error("This response has no readable text.");
      for (const text of chunks) {
        request.signal.throwIfAborted();
        this.publish({ owner, phase: "loading", error: null });
        const audio = await synthesize(text, request.signal);
        request.signal.throwIfAborted();
        await this.player.play(audio, request.signal, () => {
          if (this.request === request) this.publish({ owner, phase: "playing", error: null });
        });
      }
      if (this.request === request) this.stop();
    } catch (error) {
      if (this.request !== request) return;
      request.abort();
      this.request = null;
      this.publish({
        owner,
        phase: "error",
        error: error instanceof Error ? error.message : "Could not play this response.",
      });
    }
  }

  async togglePause() {
    const request = this.request;
    const snapshot = this.snapshot;
    try {
      if (snapshot.phase === "playing") {
        this.player.pause();
        this.publish({ ...snapshot, phase: "paused" });
      } else if (snapshot.phase === "paused") {
        await this.player.resume();
        if (this.request === request && this.snapshot === snapshot)
          this.publish({ ...snapshot, phase: "playing" });
      }
    } catch {
      if (this.request !== request) return;
      this.stop();
      this.publish({ ...snapshot, phase: "error", error: "Could not resume this response." });
    }
  }
}

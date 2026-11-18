import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { speechTextChunks } from "./text.ts";

type Phase = "idle" | "loading" | "playing" | "paused" | "error";
type Snapshot = {
  readonly owner: string | null;
  readonly phase: Phase;
  readonly error: string | null;
};

export type SpeechAudioPlayer<Audio = Uint8Array> = {
  readonly play: (
    audio: Audio,
    signal: AbortSignal,
    onPlaying: () => void,
    rate: number,
  ) => Promise<void>;
  readonly setPlaybackRate: (rate: number) => void;
  readonly canPause?: () => boolean;
  readonly pause: () => void | Promise<void>;
  readonly resume: () => Promise<void>;
};

export class VoiceOutputController<Audio = Uint8Array> {
  private snapshot: Snapshot = { owner: null, phase: "idle", error: null };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private playbackRate = 1;

  private readonly player: SpeechAudioPlayer<Audio>;

  constructor(
    player: SpeechAudioPlayer<Audio>,
    private readonly resolve: MFunctionType = mFallback,
  ) {
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

  setPlaybackRate(rate: number) {
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2)
      throw new RangeError("Playback speed must be between 0.5× and 2×.");
    this.player.setPlaybackRate(rate);
    this.playbackRate = rate;
  }

  readonly stop = () => {
    this.request?.abort();
    this.request = null;
    this.publish({ owner: null, phase: "idle", error: null });
  };

  async start(
    owner: string,
    markdown: string,
    synthesize: (text: string, signal: AbortSignal) => Promise<Audio>,
  ) {
    this.stop();
    const request = new AbortController();
    this.request = request;
    this.publish({ owner, phase: "loading", error: null });
    try {
      const chunks = speechTextChunks(markdown);
      const first = chunks[0];
      if (!first) throw new Error(this.resolve(msg("This response has no readable text.")));
      // Settle prefetch failures even when playback stops before consuming them.
      const prepare = async (text: string) => {
        try {
          request.signal.throwIfAborted();
          const audio = await synthesize(text, request.signal);
          return { ok: true as const, audio };
        } catch (error) {
          return { ok: false as const, error };
        }
      };
      let pending = prepare(first);
      for (let index = 0; index < chunks.length; index++) {
        request.signal.throwIfAborted();
        this.publish({ owner, phase: "loading", error: null });
        const prepared = await pending;
        request.signal.throwIfAborted();
        if (!prepared.ok) throw prepared.error;
        const next = chunks[index + 1];
        if (next !== undefined) pending = prepare(next);
        await this.player.play(
          prepared.audio,
          request.signal,
          () => {
            if (this.request === request) this.publish({ owner, phase: "playing", error: null });
          },
          this.playbackRate,
        );
      }
      if (this.request === request) this.stop();
    } catch (error) {
      if (this.request !== request) return;
      request.abort();
      this.request = null;
      this.publish({
        owner,
        phase: "error",
        error:
          error instanceof Error
            ? error.message
            : this.resolve(msg("Could not play this response.")),
      });
    }
  }

  readonly canPause = () => this.player.canPause?.() ?? true;

  async togglePause() {
    const request = this.request;
    const snapshot = this.snapshot;
    try {
      if (snapshot.phase === "playing") {
        await this.player.pause();
        if (this.request === request && this.snapshot === snapshot)
          this.publish({ ...snapshot, phase: "paused" });
      } else if (snapshot.phase === "paused") {
        await this.player.resume();
        if (this.request === request && this.snapshot === snapshot)
          this.publish({ ...snapshot, phase: "playing" });
      }
    } catch {
      if (this.request !== request) return;
      this.stop();
      this.publish({
        ...snapshot,
        phase: "error",
        error: this.resolve(msg("Could not resume this response.")),
      });
    }
  }
}

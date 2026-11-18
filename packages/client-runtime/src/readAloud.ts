import {
  SPEECH_SYNTHESIS_MAX_TEXT,
  type EnvironmentId,
  type ReadAloudSettings,
} from "@t3tools/contracts";
import { readAloudText, splitReadAloudText } from "@t3tools/shared/read-aloud";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const WARM_INTERVAL_MS = 4 * 60_000;

/**
 * Asks an environment to load its local model before playback, at most once per interval for each
 * environment and model. A failed request is retried the next time.
 */
export function createReadAloudWarmup(
  warm: (environmentId: EnvironmentId, model: string) => Promise<unknown>,
  now: () => number = Date.now,
) {
  const requested = new Map<string, number>();
  return (settings: ReadAloudSettings) => {
    if (settings.provider !== "local" || !settings.environmentId) return;
    const key = JSON.stringify([settings.environmentId, settings.model]);
    const last = requested.get(key);
    if (last !== undefined && now() - last < WARM_INTERVAL_MS) return;
    requested.set(key, now());
    void warm(settings.environmentId, settings.model).catch(() => requested.delete(key));
  };
}

export type SpeechPlayback = {
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  finished: Promise<void>;
};

export function createReadAloudController(
  prepare: (
    text: string,
    settings: ReadAloudSettings,
    signal: AbortSignal,
  ) => Promise<SpeechPlayback>,
  resolve: MFunctionType = mFallback,
) {
  type State = {
    id: string | null;
    status: "idle" | "loading" | "playing" | "paused" | "error";
    error?: string;
  };
  let state: State = { id: null, status: "idle" };
  let active: AbortController | null = null;
  let playback: SpeechPlayback | null = null;
  let disposing = false;
  const dispose = (current: SpeechPlayback) => {
    disposing = true;
    try {
      current.stop();
    } finally {
      disposing = false;
    }
  };
  let paused = false;
  let starting = false;
  let resumePending: (() => void) | null = null;
  const waitForResume = async () => {
    if (paused)
      await new Promise<void>((resolve) => {
        resumePending = resolve;
      });
  };
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const stop = () => {
    active?.abort();
    active = null;
    paused = false;
    starting = false;
    resumePending?.();
    resumePending = null;
    if (playback) dispose(playback);
    playback = null;
    publish({ id: null, status: "idle" });
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop,
    pause() {
      if (disposing || !active || (state.status !== "playing" && state.status !== "loading"))
        return;
      paused = true;
      publish({ ...state, status: "paused" });
      if (!starting) playback?.pause();
    },
    async resume() {
      if (state.status !== "paused" || !active) return;
      paused = false;
      if (resumePending) {
        const resume = resumePending;
        resumePending = null;
        publish({ ...state, status: "loading" });
        resume();
        return;
      }
      if (starting || !playback) {
        publish({ ...state, status: "loading" });
        return;
      }
      const owner = active;
      const id = state.id;
      try {
        starting = true;
        publish({ ...state, status: "loading" });
        await playback.play();
        if (active === owner) {
          starting = false;
          if (paused) playback.pause();
          else publish({ ...state, status: "playing" });
        }
      } catch {
        if (active === owner) {
          stop();
          publish({ id, status: "error", error: resolve(msg("Could not resume speech.")) });
        }
      }
    },
    async start(id: string, markdown: string, settings: ReadAloudSettings) {
      stop();
      if (settings.provider === "off") return;
      // Platform speech engines cap utterance length; environments stream a whole reply.
      const chunks = splitReadAloudText(
        readAloudText(markdown, settings.skipCodeBlocks),
        settings.provider === "system" ? undefined : SPEECH_SYNTHESIS_MAX_TEXT,
      );
      if (!chunks.length) return;
      const owner = new AbortController();
      active = owner;
      try {
        for (const chunk of chunks) {
          publish({ id, status: paused ? "paused" : "loading" });
          const next = await prepare(chunk, settings, owner.signal);
          if (active !== owner) {
            dispose(next);
            return;
          }
          playback = next;
          // Playback can fail while the platform is still activating its audio session.
          void next.finished.catch(() => {});
          await waitForResume();
          if (active !== owner) return;
          do {
            starting = true;
            await next.play();
            if (active !== owner) return;
            starting = false;
            if (paused) {
              next.pause();
              await waitForResume();
              if (active !== owner) return;
            } else break;
          } while (active === owner);
          publish({ id, status: "playing" });
          await next.finished;
          if (active !== owner) return;
          dispose(next);
          playback = null;
        }
        if (active === owner) stop();
      } catch (error) {
        if (active !== owner) return;
        stop();
        publish({
          id,
          status: "error",
          error:
            error instanceof Error ? error.message : resolve(msg("Could not read this response.")),
        });
      }
    },
  };
}

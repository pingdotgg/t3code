import type { ReadAloudSettings } from "@t3tools/contracts";
import { readAloudText, splitReadAloudText } from "@t3tools/shared/read-aloud";

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
          publish({ id, status: "error", error: "Could not resume speech." });
        }
      }
    },
    async start(id: string, markdown: string, settings: ReadAloudSettings) {
      stop();
      if (settings.provider === "off") return;
      const chunks = splitReadAloudText(readAloudText(markdown, settings.skipCodeBlocks));
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
          error: error instanceof Error ? error.message : "Could not read this response.",
        });
      }
    },
  };
}

import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import {
  DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE,
  type DictationSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import type { AtomRegistry } from "effect/reactivity";

import { dictationEnvironment } from "../state/dictation";
import { createDictationLevel, type DictationLevel } from "./dictationLevel";
import { PcmCapture } from "./pcmCapture";

type DictationSession = {
  readonly environmentId: EnvironmentId;
  /** Null until the environment answers `dictationStart`; frames wait in `pending` until then. */
  sessionId: DictationSessionId | null;
  /** Frames captured before the session existed, sent in order once it does. */
  readonly pending: ArrayBuffer[];
  /** Chunks sent so far; also the next chunk's `seq`. */
  chunks: number;
  /** False once the server has finished or been told to cancel. */
  open: boolean;
  /** Settles after `sessionId` is set and `pending` is flushed, or with the start failure. */
  readonly ready: Promise<string | null>;
  /** Settles with the reason the first chunk was lost, so finishing does not wait on it. */
  readonly lost: Promise<string>;
  readonly loseChunk: (message: string) => void;
};

/** Rejects once `signal` aborts, for racing work that cannot be cancelled itself. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment did not respond.";
}

// Bind captured audio and transcription to the environment selected at recording start.
export function createStreamingDictation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  /** Read when dictation starts; later changes do not move a running session. */
  readonly resolveEnvironmentId: () => EnvironmentId | null;
  /** Receives the controller's `interruptRecording` message when the session is lost. */
  readonly interrupt: (message: string) => void;
  /** Called after the recording cap stopped capture, like a native recorder's finished status. */
  readonly finishedAtLimit: (uri: string) => void;
  /** Applied to each transcript before it is inserted, e.g. to turn spoken skill names into chips. */
  readonly rewriteTranscript: (text: string) => string;
}): {
  readonly dependencies: Omit<
    VoiceInputControllerDependencies,
    "readDraft" | "commitDraft" | "onStateChange"
  >;
  readonly settle: (state: VoiceInputState) => void;
  readonly level: DictationLevel;
  /** True once the current dictation has captured any audio. */
  readonly capturedAudio: () => boolean;
} {
  const capture = new PcmCapture();
  const level = createDictationLevel();
  let session: DictationSession | null = null;
  let captureStartedAt = 0;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;

  const run = <W, A, E>(command: AtomCommand<W, A, E>, value: W) =>
    runAtomCommand(input.registry, command, value, { reportFailure: false });

  const cancelOnServer = (environmentId: EnvironmentId, sessionId: DictationSessionId) =>
    void run(dictationEnvironment.cancel, { environmentId, input: { sessionId } });

  /** Closes a session; one still starting is cancelled once the environment answers. */
  const close = (target: DictationSession | null) => {
    if (!target?.open) return;
    target.open = false;
    target.pending.length = 0;
    if (target.sessionId !== null) cancelOnServer(target.environmentId, target.sessionId);
  };

  const clearLimit = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
  };

  const sendChunk = (target: DictationSession, frame: ArrayBuffer) => {
    if (!target.open) return;
    if (target.sessionId === null) {
      target.pending.push(frame);
      return;
    }
    const sessionId = target.sessionId;
    const seq = target.chunks;
    target.chunks += 1;
    void run(dictationEnvironment.append, {
      environmentId: target.environmentId,
      input: { sessionId, seq, pcm: Base64.encode(new Uint8Array(frame)) },
    }).then((result) => {
      if (result._tag !== "Failure" || !target.open) return;
      const message = `Dictation stopped: ${failureMessage(result)}`;
      target.loseChunk(message);
      if (session === target) input.interrupt(message);
    });
  };

  /** Asks the environment for a session; frames captured meanwhile queue on it. */
  const begin = (environmentId: EnvironmentId): DictationSession => {
    const pending: ArrayBuffer[] = [];
    let loseChunk: (message: string) => void = () => undefined;
    const lost = new Promise<string>((resolve) => {
      loseChunk = resolve;
    });
    const target: DictationSession = {
      lost,
      loseChunk,
      environmentId,
      sessionId: null,
      pending,
      chunks: 0,
      open: true,
      ready: run(dictationEnvironment.start, { environmentId, input: {} }).then((started) => {
        if (started._tag === "Failure") return failureMessage(started);
        const { sessionId } = started.value;
        if (!target.open) {
          cancelOnServer(environmentId, sessionId);
          return null;
        }
        target.sessionId = sessionId;
        for (const frame of pending.splice(0)) sendChunk(target, frame);
        return null;
      }),
    };
    return target;
  };

  const sessionUri = (target: DictationSession) => `dictation:${target.sessionId ?? "pending"}`;

  const transcriber: VoiceTranscriber = {
    prepare: async ({ signal }) => {
      const current = session;
      if (current === null) {
        throw new VoiceTranscriptionError("unavailable", "No environment can transcribe.");
      }
      // A start that never answers must not hold dictation open after a cancel.
      const failure = await Promise.race([current.ready, current.lost, rejectOnAbort(signal)]);
      if (failure !== null) throw new VoiceTranscriptionError("preparation-failed", failure);
      const sessionId = current.sessionId;
      if (signal.aborted || sessionId === null) close(current);
      if (sessionId === null) {
        throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
      }
      throwIfVoiceTranscriptionAborted(signal);
      signal.addEventListener("abort", () => close(current), { once: true });
      return {
        // Replaced by the locale the environment reports with the transcript.
        locale: "en",
        transcribe: async (_uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          // A lost chunk would leave the environment waiting for it, so fail at once instead.
          const finished = await Promise.race([
            run(dictationEnvironment.finish, {
              environmentId: current.environmentId,
              input: { sessionId, chunkCount: current.chunks },
            }),
            current.lost.then((message) => {
              throw new VoiceTranscriptionError("transcription-failed", message);
            }),
            rejectOnAbort(options.signal),
          ]);
          if (finished._tag === "Failure") {
            throw new VoiceTranscriptionError("transcription-failed", failureMessage(finished));
          }
          current.open = false;
          return { ...finished.value, text: input.rewriteTranscript(finished.value.text) };
        },
      };
    },
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return session === null ? null : sessionUri(session);
    },
    prepareToRecordAsync: async () => undefined,
    // Capture already runs from the permission step; this only arms the recording cap.
    record: ({ forDuration }) => {
      const current = session;
      if (current === null) throw new Error("No dictation session is open.");
      clearLimit();
      limitTimer = setTimeout(
        () => {
          limitTimer = null;
          void capture.stop().then(() => input.finishedAtLimit(sessionUri(current)));
        },
        Math.max(0, forDuration * 1_000 - (Date.now() - captureStartedAt)),
      );
    },
    stop: async () => {
      clearLimit();
      await capture.stop();
      level.set(0);
    },
  };

  return {
    dependencies: {
      recorder,
      getTranscriber: () => (input.resolveEnvironmentId() === null ? null : transcriber),
      // Permission prompts can outlive server sessions, so request a session only after consent.
      requestPermission: async () => {
        const environmentId = input.resolveEnvironmentId();
        close(session);
        session = null;
        const access = await capture.open();
        if (!access.granted) {
          return { granted: false, canAskAgain: true, message: access.message };
        }
        session = environmentId === null ? null : begin(environmentId);
        await capture.prepare();
        const current = session;
        captureStartedAt = Date.now();
        let capturedBytes = 0;
        const maxBytes = DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE * 2;
        capture.start((frame) => {
          const remaining = maxBytes - capturedBytes;
          if (current === null || remaining <= 0) return;
          const chunk = frame.byteLength > remaining ? frame.slice(0, remaining) : frame;
          capturedBytes += chunk.byteLength;
          sendChunk(current, chunk);
          if (capturedBytes === maxBytes) {
            clearLimit();
            void capture.stop().then(() => input.finishedAtLimit(sessionUri(current)));
          }
        }, level.set);
        return { granted: true, canAskAgain: true };
      },
      // The permission step already loaded the worklet and started capture.
      configureRecording: async () => undefined,
      releaseRecording: async () => capture.release(),
      // Nothing is stored locally; `settle` cancels a session that never finished.
      deleteRecording: () => undefined,
    },
    settle: (state) => {
      if (state.phase !== "idle" && state.phase !== "error") return;
      clearLimit();
      capture.release();
      level.set(0);
      close(session);
      session = null;
    },
    level,
    capturedAudio: () => session !== null && (session.chunks > 0 || session.pending.length > 0),
  };
}

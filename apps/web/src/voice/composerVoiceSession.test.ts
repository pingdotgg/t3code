import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
} from "@t3tools/client-runtime/voice-input";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerVoiceSession,
  formatVoiceElapsed,
  resolveVoiceMicAvailability,
  resolveVoiceSendDisabledReason,
  VOICE_BUSY_SEND_DISABLED_REASON,
  type ComposerVoiceCommit,
  type ComposerVoiceRecorder,
  type ComposerVoiceSessionDependencies,
} from "./composerVoiceSession";

type Transcript = { text: string; locale: string };

type DraftHarness = {
  ownerKey: string;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  commits: ComposerVoiceCommit[];
};

function createDraft(text: string, cursor: number, ownerKey = "env-1:thread-1"): DraftHarness {
  return { ownerKey, text, selectionStart: cursor, selectionEnd: cursor, commits: [] };
}

function applyCommit(draft: DraftHarness, commit: ComposerVoiceCommit): boolean {
  if (draft.text.slice(commit.rangeStart, commit.rangeEnd) !== commit.expectedText) return false;
  draft.text =
    draft.text.slice(0, commit.rangeStart) + commit.insertion + draft.text.slice(commit.rangeEnd);
  draft.commits.push(commit);
  return true;
}

class FakeRecorder implements ComposerVoiceRecorder {
  readonly mimeType = "audio/webm";
  started = false;
  stopped = false;
  disposed = false;
  failStop = false;
  useDeferredStop = false;
  audio = new Blob(["audio-bytes"], { type: "audio/webm" });
  onError: ((error: Error) => void) | null = null;
  private deferredStop: {
    promise: Promise<Blob>;
    resolve: (blob: Blob) => void;
    reject: (reason: unknown) => void;
  } | null = null;

  start(): void {
    this.started = true;
  }

  stop(): Promise<Blob> {
    this.stopped = true;
    if (this.failStop) return Promise.reject(new Error("stop failed"));
    if (this.useDeferredStop) {
      if (!this.deferredStop) {
        let resolveFn = (_blob: Blob) => {};
        let rejectFn = (_reason: unknown) => {};
        const promise = new Promise<Blob>((resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        });
        this.deferredStop = { promise, resolve: resolveFn, reject: rejectFn };
      }
      return this.deferredStop.promise;
    }
    return Promise.resolve(this.audio);
  }

  resolveDeferredStop(): void {
    this.deferredStop?.resolve(this.audio);
    this.deferredStop = null;
  }

  simulateRecorderError(message = "Microphone recording failed."): void {
    this.onError?.(new Error(message));
  }

  dispose(): void {
    this.disposed = true;
    // Mirror createMediaRecorderVoiceRecorder: settling a pending stop() so
    // finishRecording() can't hang with `finishing` stuck true.
    const pending = this.deferredStop;
    this.deferredStop = null;
    pending?.reject(new Error("Voice recording was cancelled."));
  }
}

type DeferredTranscript = {
  promise: Promise<Transcript>;
  resolve: (value: Transcript) => void;
  reject: (reason: unknown) => void;
};

function createDeferredTranscriber() {
  const pending: DeferredTranscript[] = [];
  const transcribe = (audio: Blob, options: { signal: AbortSignal }): Promise<Transcript> => {
    void audio;
    void options;
    let resolveFn = (_value: Transcript) => {};
    let rejectFn = (_reason: unknown) => {};
    const promise = new Promise<Transcript>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const deferred: DeferredTranscript = {
      promise,
      resolve: (value) => resolveFn(value),
      reject: (reason) => rejectFn(reason),
    };
    pending.push(deferred);
    return promise;
  };
  return { transcribe, pending };
}

/** Deterministic microtask flush so `stop()` reaches the stubbed transcriber. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createSession(input: {
  draft: DraftHarness;
  transcribe?: ComposerVoiceSessionDependencies["transcribe"];
  requestMicrophone?: () => Promise<MediaStream>;
  now?: () => number;
}) {
  const phases: string[] = [];
  const recorder = new FakeRecorder();
  const stoppedTracks: string[] = [];
  const stream = {
    getTracks: () => [{ stop: () => stoppedTracks.push("track") }],
  } as unknown as MediaStream;
  let microphoneCalls = 0;
  const session = new ComposerVoiceSession({
    readDraft: () => ({
      ownerKey: input.draft.ownerKey,
      text: input.draft.text,
      selectionStart: input.draft.selectionStart,
      selectionEnd: input.draft.selectionEnd,
    }),
    commitDraft: (commit) => applyCommit(input.draft, commit),
    transcribe:
      input.transcribe ??
      (async () => {
        throw new Error("transcriber not stubbed");
      }),
    requestMicrophone:
      input.requestMicrophone ??
      (async () => {
        microphoneCalls += 1;
        return stream;
      }),
    createRecorder: (_stream, callbacks) => {
      recorder.onError = callbacks.onError;
      return recorder;
    },
    onStateChange: (state) => {
      phases.push(state.phase);
    },
    now: input.now ?? Date.now,
  });
  return {
    session,
    recorder,
    phases,
    stoppedTracks,
    microphoneCalls: () => microphoneCalls,
  };
}

async function stopAndResolve(
  session: ComposerVoiceSession,
  pending: DeferredTranscript[],
  transcript: Transcript,
): Promise<void> {
  const stopPromise = session.stop();
  await flushAsync();
  expect(pending).toHaveLength(1);
  pending[0]?.resolve(transcript);
  await stopPromise;
}

describe("ComposerVoiceSession transcript commit", () => {
  it("inserts the transcript at the cursor with boundary spacing", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, phases } = createSession({ draft, transcribe });

    await session.start();
    await stopAndResolve(session, pending, { text: "world", locale: "en-US" });

    expect(draft.text).toBe("hello world");
    expect(draft.commits).toHaveLength(1);
    expect(draft.commits[0]).toMatchObject({ rangeStart: 5, rangeEnd: 5 });
    expect(session.currentState.phase).toBe("idle");
    expect(phases).toContain("recording");
    expect(phases).toContain("transcribing");
  });

  it("replaces the captured selection instead of appending", async () => {
    const draft = createDraft("hello brave world", 6);
    draft.selectionEnd = 11;
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    await stopAndResolve(session, pending, { text: "new", locale: "en" });

    expect(draft.text).toBe("hello new world");
  });

  it("trims the transcript in an empty draft", async () => {
    const draft = createDraft("", 0);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    await stopAndResolve(session, pending, { text: "  hello  ", locale: "en" });

    expect(draft.text).toBe("hello");
  });
});

describe("ComposerVoiceSession draft guards", () => {
  it("drops a late transcript when the draft text changed mid-recording", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    draft.text = "hello edited";
    await stopAndResolve(session, pending, { text: "late words", locale: "en" });

    expect(draft.commits).toHaveLength(0);
    expect(draft.text).toBe("hello edited");
    expect(session.currentState.phase).toBe("error");
    expect(session.currentState.error).toContain("draft changed");
    session.dismissError();
    expect(session.currentState.phase).toBe("idle");
  });

  it("drops a late transcript when the thread switched mid-recording", async () => {
    const draft = createDraft("hello", 5, "env-1:thread-1");
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    draft.ownerKey = "env-1:thread-2";
    draft.text = "other draft";
    await stopAndResolve(session, pending, { text: "late words", locale: "en" });

    expect(draft.commits).toHaveLength(0);
    expect(session.currentState.phase).toBe("error");
  });

  it("reports an empty transcript without touching the draft", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    await stopAndResolve(session, pending, { text: "   ", locale: "en" });

    expect(draft.commits).toHaveLength(0);
    expect(draft.text).toBe("hello");
    expect(session.currentState.phase).toBe("error");
    expect(session.currentState.error).toContain("No speech");
  });

  it("ignores a transcript that resolves after dispose", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    const stopPromise = session.stop();
    session.dispose();
    await flushAsync();
    pending[0]?.resolve({ text: "late words", locale: "en" });
    await stopPromise;

    expect(draft.commits).toHaveLength(0);
  });
});

describe("ComposerVoiceSession lifecycle", () => {
  it("blocks sending while preparing, recording, and transcribing", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const seen: string[] = [];
    const session = new ComposerVoiceSession({
      readDraft: () => ({ ...draft, selectionStart: 5, selectionEnd: 5 }),
      commitDraft: (commit) => applyCommit(draft, commit),
      transcribe,
      requestMicrophone: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      createRecorder: () => new FakeRecorder(),
      onStateChange: (state) => {
        seen.push(state.phase);
        expect(voiceInputBlocksSubmission(state)).toBe(state.phase !== "idle");
      },
    });

    await session.start();
    expect(session.busy).toBe(true);
    const stopPromise = session.stop();
    expect(session.busy).toBe(true);
    await flushAsync();
    pending[0]?.resolve({ text: "world", locale: "en" });
    await stopPromise;

    expect(session.busy).toBe(false);
    expect(seen).toEqual(["preparing", "recording", "transcribing", "idle"]);
  });

  it("cancels a recording without transcribing and releases the microphone", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder, stoppedTracks } = createSession({ draft, transcribe });

    await session.start();
    expect(session.currentState.phase).toBe("recording");
    session.cancel();

    expect(session.currentState.phase).toBe("idle");
    expect(pending).toHaveLength(0);
    expect(recorder.disposed).toBe(true);
    expect(stoppedTracks).toEqual(["track"]);
    expect(draft.commits).toHaveLength(0);
  });

  it("auto-stops at the five-minute cap", async () => {
    let now = 1_000_000;
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe, now: () => now });

    await session.start();
    now += (VOICE_RECORDING_LIMIT_SECONDS + 10) * 1000;
    session.tick();
    await flushAsync();

    expect(session.currentState.phase).toBe("transcribing");
    expect(pending).toHaveLength(1);
    pending[0]?.resolve({ text: "capped", locale: "en" });
    await pending[0]?.promise;
    await flushAsync();

    expect(draft.text).toBe("hello capped");
    expect(session.currentState.phase).toBe("idle");
  });

  it("surfaces microphone denial as a retryable error", async () => {
    const draft = createDraft("hello", 5);
    const denial = new DOMException("denied", "NotAllowedError");
    const { session } = createSession({
      draft,
      requestMicrophone: () => Promise.reject(denial),
    });

    await session.start();

    expect(session.currentState.phase).toBe("error");
    expect(session.currentState.error).toContain("denied");
    expect(session.currentState.errorAction).toBe("retry");
  });

  it("ignores a second start while busy", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe } = createDeferredTranscriber();
    const fixture = createSession({ draft, transcribe });

    await fixture.session.start();
    await fixture.session.start();

    expect(fixture.microphoneCalls()).toBe(1);
    fixture.session.cancel();
  });

  it("stopping without a recording is a no-op", async () => {
    const draft = createDraft("hello", 5);
    const { session, phases } = createSession({ draft });

    await session.stop();

    expect(phases).toHaveLength(0);
    expect(session.currentState.phase).toBe("idle");
  });

  it("surfaces an async recorder error during recording and releases the mic", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder, stoppedTracks } = createSession({ draft, transcribe });

    await session.start();
    expect(session.currentState.phase).toBe("recording");
    recorder.simulateRecorderError();

    expect(session.currentState.phase).toBe("error");
    expect(session.currentState.error).toContain("Microphone recording failed");
    expect(session.busy).toBe(false);
    expect(recorder.disposed).toBe(true);
    expect(stoppedTracks).toEqual(["track"]);
    expect(pending).toHaveLength(0);
  });

  it("releases the microphone when recorder.stop() rejects", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe } = createDeferredTranscriber();
    const { session, recorder, stoppedTracks } = createSession({ draft, transcribe });
    recorder.failStop = true;

    await session.start();
    await session.stop();

    expect(session.currentState.phase).toBe("error");
    expect(recorder.disposed).toBe(true);
    expect(stoppedTracks).toEqual(["track"]);
  });

  it("cancel during the recording handoff settles and unblocks the next stop", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder } = createSession({ draft, transcribe });
    recorder.useDeferredStop = true;

    await session.start();
    const stopPromise = session.stop();
    await flushAsync();
    expect(session.currentState.phase).toBe("transcribing");
    // Cancel while recorder.stop() is still pending: dispose rejects the
    // pending stop so finishRecording() settles instead of hanging.
    session.cancel();
    await stopPromise;

    expect(session.currentState.phase).toBe("idle");
    expect(pending).toHaveLength(0);

    // A fresh recording must still transcribe after the cancelled handoff.
    recorder.useDeferredStop = false;
    await session.start();
    expect(session.currentState.phase).toBe("recording");
    const retryStop = session.stop();
    await flushAsync();
    expect(pending).toHaveLength(1);
    pending[0]?.resolve({ text: "retry", locale: "en" });
    await retryStop;
    expect(draft.text).toBe("hello retry");
    expect(session.currentState.phase).toBe("idle");
  });
});

describe("composer voice send and mic gating", () => {
  it("blocks send while voice input is busy without overriding explicit reasons", () => {
    expect(
      resolveVoiceSendDisabledReason({ external: null, voiceBusy: true, fallback: null }),
    ).toBe(VOICE_BUSY_SEND_DISABLED_REASON);
    expect(
      resolveVoiceSendDisabledReason({ external: "Connecting", voiceBusy: true, fallback: null }),
    ).toBe("Connecting");
    expect(
      resolveVoiceSendDisabledReason({ external: null, voiceBusy: false, fallback: "Add a file" }),
    ).toBe("Add a file");
    expect(
      resolveVoiceSendDisabledReason({ external: null, voiceBusy: false, fallback: null }),
    ).toBeNull();
  });

  it("keeps the mic visible but disabled per provider state", () => {
    expect(
      resolveVoiceMicAvailability({
        driverKind: ProviderDriverKind.make("codex"),
        codexVoiceAvailable: true,
        composerDisabled: false,
      }),
    ).toEqual({ available: true });
    expect(
      resolveVoiceMicAvailability({
        driverKind: ProviderDriverKind.make("claudeAgent"),
        codexVoiceAvailable: false,
        composerDisabled: false,
      }),
    ).toEqual({ available: false, reason: "Voice for this provider is coming soon" });
    expect(
      resolveVoiceMicAvailability({
        driverKind: ProviderDriverKind.make("codex"),
        codexVoiceAvailable: false,
        composerDisabled: false,
      }),
    ).toEqual({ available: false, reason: "Sign in with `codex login`" });
    expect(
      resolveVoiceMicAvailability({
        driverKind: ProviderDriverKind.make("codex"),
        codexVoiceAvailable: true,
        composerDisabled: true,
      }).available,
    ).toBe(false);
  });

  it("formats elapsed time as m:ss", () => {
    expect(formatVoiceElapsed(0)).toBe("0:00");
    expect(formatVoiceElapsed(7)).toBe("0:07");
    expect(formatVoiceElapsed(65)).toBe("1:05");
    expect(formatVoiceElapsed(300)).toBe("5:00");
  });
});

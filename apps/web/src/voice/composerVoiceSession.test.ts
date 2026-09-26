import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
} from "@t3tools/client-runtime/voice-input";
import { createDictationFormatter } from "@t3tools/shared/voicePunctuation";
import { DEFAULT_DICTATION_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetVoiceInputGlobalsForTests } from "@t3tools/client-runtime/voice-input";

beforeEach(() => resetVoiceInputGlobalsForTests());

import {
  ComposerVoiceSession,
  formatVoiceElapsed,
  resolveVoiceMicAvailability,
  resolveVoiceSendDisabledReason,
  VOICE_BUSY_SEND_DISABLED_REASON,
  type ComposerVoiceCommit,
  type ComposerVoiceDraft,
  type ComposerVoiceRecorder,
  type ComposerVoiceTranscript,
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
  draft.selectionStart = commit.rangeStart + commit.insertion.length;
  draft.selectionEnd = draft.selectionStart;
  draft.commits.push(commit);
  return true;
}

class FakeRecorder implements ComposerVoiceRecorder {
  transcribe: (audio: Blob, options: { signal: AbortSignal }) => Promise<ComposerVoiceTranscript> =
    async () => {
      throw new Error("transcriber not stubbed");
    };
  aborter = new AbortController();
  started = false;
  stopped = false;
  disposed = false;
  failStop = false;
  useDeferredStop = false;
  audio = new Blob(["audio-bytes"], { type: "audio/webm" });
  onTranscript: ((text: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  private deferredStop: {
    promise: Promise<Blob>;
    resolve: (blob: Blob) => void;
    reject: (reason: unknown) => void;
  } | null = null;

  start(): void {
    this.started = true;
  }

  async stop(): Promise<ComposerVoiceTranscript> {
    const audio = await this.stopAudio();
    if (!audio.size) return { text: "", locale: "en" };
    return this.transcribe(audio, { signal: this.aborter.signal });
  }

  stopAudio(): Promise<Blob> {
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
    this.aborter.abort();
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
  transcribe?: FakeRecorder["transcribe"];
  requestMicrophone?: () => Promise<MediaStream>;
  now?: () => number;
  formatTranscript?: (text: string) => string;
}) {
  const phases: string[] = [];
  const completions: ComposerVoiceDraft[] = [];
  const recorder = new FakeRecorder();
  if (input.transcribe) recorder.transcribe = input.transcribe;
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
    requestMicrophone:
      input.requestMicrophone ??
      (async () => {
        microphoneCalls += 1;
        return stream;
      }),
    createRecorder: (_stream, callbacks) => {
      recorder.onError = callbacks.onError;
      recorder.onTranscript = callbacks.onTranscript;
      return recorder;
    },
    onComplete: (draft) => {
      expect(session.busy).toBe(false);
      completions.push(draft);
    },
    onStateChange: (state) => {
      phases.push(state.phase);
    },
    now: input.now ?? Date.now,
    ...(input.formatTranscript ? { formatTranscript: input.formatTranscript } : {}),
  });
  return {
    session,
    recorder,
    phases,
    stoppedTracks,
    completions,
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
  it("inserts at the current caret after typing during recording", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session } = createSession({ draft, transcribe });

    await session.start();
    draft.text = "hello edited";
    draft.selectionStart = draft.selectionEnd = draft.text.length;
    await stopAndResolve(session, pending, { text: "late words", locale: "en" });

    expect(draft.commits).toHaveLength(1);
    expect(draft.text).toBe("hello edited late words");
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
      requestMicrophone: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      createRecorder: () => {
        const recorder = new FakeRecorder();
        recorder.transcribe = transcribe;
        return recorder;
      },
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

  it("reports unsupported providers without promising future support", () => {
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
    ).toEqual({ available: false, reason: "Voice input is unavailable for this provider" });
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

describe("editable live dictation", () => {
  it("inserts live words once and follows the caret when it moves", async () => {
    const draft = createDraft("hello", 5);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder } = createSession({ draft, transcribe });
    await session.start();
    recorder.onTranscript?.("wonderful");
    recorder.onTranscript?.("wonderful world");
    expect(draft.text).toBe("hello wonderful world");
    draft.selectionStart = draft.selectionEnd = 0;
    recorder.onTranscript?.("wonderful world first");
    expect(draft.text).toBe("first hello wonderful world");
    await stopAndResolve(session, pending, { text: "wonderful world first", locale: "en" });
    expect(draft.text).toBe("first hello wonderful world");
    expect(draft.selectionStart).toBe(6);
  });

  it("preserves typed corrections and replaces a new selection", async () => {
    const draft = createDraft("", 0);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder } = createSession({ draft, transcribe });
    await session.start();
    recorder.onTranscript?.("hello world");
    draft.text = "Hello world!";
    draft.selectionStart = 6;
    draft.selectionEnd = 11;
    recorder.onTranscript?.("hello world everyone");
    expect(draft.text).toBe("Hello everyone!");
    await stopAndResolve(session, pending, { text: "hello world everyone", locale: "en" });
    expect(draft.text).toBe("Hello everyone!");
  });

  it("handles spoken punctuation split across chunks without duplication", async () => {
    const draft = createDraft("", 0);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder } = createSession({ draft, transcribe });
    await session.start();
    recorder.onTranscript?.("is it ready question");
    recorder.onTranscript?.("is it ready question mark");
    expect(draft.text).toBe("is it ready?");
    recorder.onTranscript?.("is it ready question mark yes comma it is period");
    expect(draft.text).toBe("is it ready? yes, it is.");
    await stopAndResolve(session, pending, {
      text: "is it ready question mark yes comma it is period",
      locale: "en",
    });
    expect(draft.text).toBe("is it ready? yes, it is.");
  });

  it("keeps edits made while waiting for the last words", async () => {
    const draft = createDraft("", 0);
    const { transcribe, pending } = createDeferredTranscriber();
    const { session, recorder } = createSession({ draft, transcribe });
    await session.start();
    recorder.onTranscript?.("check it");
    const stopped = session.stop();
    await flushAsync();
    draft.text = "Please check it";
    draft.selectionStart = draft.selectionEnd = draft.text.length;
    pending[0]?.resolve({ text: "check it again", locale: "en" });
    await stopped;
    expect(draft.text).toBe("Please check it again");
    expect(session.currentState.phase).toBe("idle");
  });

  it("keeps visible text on cancel and ignores old chunks after restarting", async () => {
    const draft = createDraft("keep this", 9);
    const { session, recorder } = createSession({ draft });
    await session.start();
    const oldTranscript = recorder.onTranscript;
    oldTranscript?.("and this");
    session.cancel();
    expect(draft.text).toBe("keep this and this");
    oldTranscript?.("late cancelled chunk");
    await session.start();
    recorder.onTranscript?.("new recording");
    oldTranscript?.("late old recording");
    expect(draft.text).toBe("keep this and this new recording");
    session.dispose();
  });
});

describe("live formatting commands", () => {
  it("preserves whitespace inside saved snippets", async () => {
    const draft = createDraft("", 0);
    const { session, recorder } = createSession({
      draft,
      formatTranscript: createDictationFormatter({
        ...DEFAULT_DICTATION_SETTINGS,
        replacements: [{ kind: "snippet", phrase: "my code", replacement: "  run();\n" }],
      }),
    });
    await session.start();
    recorder.onTranscript?.("my code");
    expect(draft.text).toBe("  run();\n");
    session.dispose();
  });
  it("keeps paragraph breaks and supports undoing a dictated insertion", async () => {
    const draft = createDraft("typed text", 10);
    const { session, recorder } = createSession({
      draft,
      formatTranscript: createDictationFormatter(DEFAULT_DICTATION_SETTINGS),
    });
    await session.start();
    recorder.onTranscript?.("new paragraph");
    expect(draft.text).toBe("typed text\n\n");
    recorder.onTranscript?.("new paragraph mistaken words");
    expect(draft.text).toBe("typed text\n\nmistaken words");
    recorder.onTranscript?.("new paragraph mistaken words scratch that");
    expect(draft.text).toBe("typed text");
    recorder.onTranscript?.("new paragraph mistaken words scratch that corrected words");
    expect(draft.text).toBe("typed text corrected words");
    session.dispose();
  });
  it("does not erase a selection for a filler-only chunk", async () => {
    const draft = createDraft("replace me", 0);
    draft.selectionEnd = 10;
    const { session, recorder } = createSession({
      draft,
      formatTranscript: createDictationFormatter(DEFAULT_DICTATION_SETTINGS),
    });
    await session.start();
    recorder.onTranscript?.("um");
    expect(draft.text).toBe("replace me");
    recorder.onTranscript?.("um new words");
    expect(draft.text).toBe("new words");
    session.dispose();
  });
});

describe("post-dictation polish handoff", () => {
  it("hands off the complete draft after final words and releases the busy state first", async () => {
    const draft = createDraft("hello", 5);
    const { session, completions } = createSession({
      draft,
      transcribe: async () => ({ text: "world", locale: "en" }),
    });
    await session.start();
    await session.stop();
    expect(completions).toEqual([
      { ownerKey: draft.ownerKey, text: "hello world", selectionStart: 0, selectionEnd: 11 },
    ]);
    await session.stop();
    expect(completions).toHaveLength(1);
  });
  it("preserves edits made after the last live chunk in the handoff", async () => {
    const draft = createDraft("", 0);
    const { session, recorder, completions } = createSession({
      draft,
      transcribe: async () => ({ text: "hello", locale: "en" }),
    });
    await session.start();
    recorder.onTranscript?.("hello");
    draft.text = "hello edited";
    await session.stop();
    expect(completions[0]?.text).toBe("hello edited");
  });
  it("does not polish cancelled or failed recordings", async () => {
    const draft = createDraft("", 0);
    const { session, recorder, completions } = createSession({
      draft,
      transcribe: async () => ({ text: "hello", locale: "en" }),
    });
    await session.start();
    recorder.onTranscript?.("hello");
    session.cancel();
    expect(completions).toEqual([]);
    await session.start();
    recorder.failStop = true;
    await session.stop();
    expect(completions).toEqual([]);
  });
});

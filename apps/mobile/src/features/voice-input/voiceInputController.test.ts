import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resetVoiceInputGlobalsForTests,
  resolveTranscriptCommit,
  resolveVoiceComposerPresentation,
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceRecorder,
} from "./voiceInputController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestRecorder implements VoiceRecorder {
  uri: string | null = "file:///voice.m4a";
  readonly prepareToRecordAsync = vi.fn(async () => undefined);
  readonly record = vi.fn();
  readonly stop = vi.fn(async () => undefined);
}

function draft(overrides: Partial<VoiceDraftSnapshot> = {}): VoiceDraftSnapshot {
  return {
    ownerKey: "environment:thread",
    text: "hello world",
    selection: { start: 6, end: 11 },
    revision: 1,
    ...overrides,
  };
}

function createHarness(
  overrides: Partial<VoiceInputControllerDependencies> = {},
  initialDraft = draft(),
) {
  const recorder = new TestRecorder();
  let currentDraft: VoiceDraftSnapshot | null = initialDraft;
  const commits: Array<{ text: string; selection: { start: number; end: number } }> = [];
  const deleted: string[] = [];
  const dependencies: VoiceInputControllerDependencies = {
    recorder,
    isAvailable: () => true,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    prepareTranscription: async () => "en-US",
    transcribeRecording: async () => "new text",
    configureRecording: async () => undefined,
    releaseRecording: async () => undefined,
    deleteRecording: (uri) => deleted.push(uri),
    readDraft: () => currentDraft,
    commitDraft: (text, selection) => commits.push({ text, selection }),
    onStateChange: vi.fn(),
    ...overrides,
  };
  return {
    controller: new VoiceInputController(dependencies),
    recorder,
    commits,
    deleted,
    setDraft: (next: VoiceDraftSnapshot | null) => {
      currentDraft = next;
    },
  };
}

describe("resolveTranscriptCommit", () => {
  it("replaces the recorded UTF-16 selection around emoji and composer tokens", () => {
    const text = "Fix 🧪 then $review please";
    const tokenStart = text.indexOf("$review");
    const captured = draft({
      text,
      selection: { start: tokenStart, end: tokenStart + "$review".length },
    });

    expect(resolveTranscriptCommit(captured, captured, "use the mobile skill", "en-US")).toEqual({
      kind: "commit",
      text: "Fix 🧪 then use the mobile skill please",
      selection: { start: tokenStart + "use the mobile skill".length, end: tokenStart + 20 },
    });
  });

  it("does not replace text after the owner, text, or revision changes", () => {
    const captured = draft();
    expect(
      resolveTranscriptCommit(captured, draft({ ownerKey: "other" }), "text", "en-US"),
    ).toEqual({
      kind: "stale",
    });
    expect(resolveTranscriptCommit(captured, draft({ text: "newer" }), "text", "en-US")).toEqual({
      kind: "stale",
    });
    expect(resolveTranscriptCommit(captured, draft({ revision: 2 }), "text", "en-US")).toEqual({
      kind: "stale",
    });
  });

  it("adds English spacing at empty start, middle, and end caret boundaries", () => {
    const atEnd = draft({
      text: "Fix cache.",
      selection: { start: "Fix cache.".length, end: "Fix cache.".length },
    });
    expect(resolveTranscriptCommit(atEnd, atEnd, "Also fix tests.", "en-US")).toMatchObject({
      kind: "commit",
      text: "Fix cache. Also fix tests.",
    });
    expect(resolveTranscriptCommit(atEnd, atEnd, "Also fix tests.", "en_US")).toMatchObject({
      kind: "commit",
      text: "Fix cache. Also fix tests.",
    });

    const atStart = draft({ text: "Fix cache.", selection: { start: 0, end: 0 } });
    expect(resolveTranscriptCommit(atStart, atStart, "First", "en-US")).toMatchObject({
      kind: "commit",
      text: "First Fix cache.",
    });

    const inMiddle = draft({ text: "Fix cache.", selection: { start: 4, end: 4 } });
    expect(resolveTranscriptCommit(inMiddle, inMiddle, "also", "en-US")).toMatchObject({
      kind: "commit",
      text: "Fix also cache.",
    });
  });

  it("does not add English boundary spaces to CJK or selected inline text", () => {
    const cjk = draft({ text: "修正キャッシュ", selection: { start: 8, end: 8 } });
    expect(resolveTranscriptCommit(cjk, cjk, "テストも", "ja-JP")).toMatchObject({
      kind: "commit",
      text: "修正キャッシュテストも",
    });

    const selected = draft({ text: "one $skill two", selection: { start: 4, end: 10 } });
    expect(resolveTranscriptCommit(selected, selected, "new", "en-US")).toMatchObject({
      kind: "commit",
      text: "one new two",
    });
  });
});

describe("VoiceInputController", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it("checks support and permission before recording", async () => {
    const unsupported = createHarness({ isAvailable: () => false });
    await unsupported.controller.start();
    expect(unsupported.controller.currentState.error).toContain("not available");
    expect(unsupported.recorder.record).not.toHaveBeenCalled();

    const denied = createHarness({
      requestPermission: async () => ({ granted: false, canAskAgain: false }),
    });
    await denied.controller.start();
    expect(denied.controller.currentState.errorAction).toBe("settings");
    expect(denied.recorder.record).not.toHaveBeenCalled();
  });

  it("blocks submit while voice input can still change the draft", () => {
    expect(voiceInputBlocksSubmission({ phase: "preparing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputBlocksSubmission({ phase: "recording", error: null, errorAction: null })).toBe(
      true,
    );
    expect(
      voiceInputBlocksSubmission({ phase: "transcribing", error: null, errorAction: null }),
    ).toBe(true);
    expect(voiceInputBlocksSubmission({ phase: "idle", error: null, errorAction: null })).toBe(
      false,
    );
  });

  it("maps voice states to stable composer actions and editor read-only state", () => {
    expect(
      resolveVoiceComposerPresentation({ phase: "idle", error: null, errorAction: null }, 0),
    ).toEqual({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: null,
      statusLabel: null,
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "preparing", error: null, errorAction: null }, 0),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Preparing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "recording", error: null, errorAction: null }, 64),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Recording 1:04",
      confirmationEnabled: true,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "transcribing", error: null, errorAction: null },
        0,
      ),
    ).toMatchObject({
      statusLabel: "Transcribing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "error", error: "Microphone unavailable", errorAction: "retry" },
        0,
      ),
    ).toMatchObject({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: "error",
      statusLabel: "Microphone unavailable",
    });

    expect(voiceInputFreezesEditor({ phase: "preparing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "recording", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "transcribing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "idle", error: null, errorAction: null })).toBe(false);
  });

  it("uses the native five-minute cap and commits one final transcript", async () => {
    const harness = createHarness();
    await harness.controller.start();
    expect(harness.recorder.record).toHaveBeenCalledWith({
      forDuration: VOICE_RECORDING_LIMIT_SECONDS,
    });

    const stopping = harness.controller.stop();
    harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///voice.m4a",
    });
    await stopping;

    expect(harness.commits).toEqual([
      { text: "hello new text", selection: { start: 14, end: 14 } },
    ]);
    expect(harness.deleted).toEqual(["file:///voice.m4a"]);
  });

  it("keeps the draft unchanged when transcription is canceled", async () => {
    const transcription = deferred<string>();
    const harness = createHarness({ transcribeRecording: () => transcription.promise });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.controller.cancel();
    transcription.resolve("late text");
    await stopping;

    expect(harness.commits).toEqual([]);
    expect(harness.deleted).toEqual(["file:///voice.m4a"]);
    expect(harness.controller.currentState.phase).toBe("idle");
  });

  it("releases the microphone before transcription starts", async () => {
    const events: string[] = [];
    const harness = createHarness({
      releaseRecording: async () => {
        events.push("released");
      },
      transcribeRecording: async () => {
        events.push("transcribed");
        return "done";
      },
    });
    await harness.controller.start();
    await harness.controller.stop();

    expect(events).toEqual(["released", "transcribed"]);
  });

  it("retries audio-session release during final cleanup", async () => {
    const releaseRecording = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    const harness = createHarness({ releaseRecording });
    await harness.controller.start();
    await harness.controller.stop();

    expect(releaseRecording).toHaveBeenCalledTimes(2);
  });

  it("leaves transcription with an error when recorder finalization fails", async () => {
    const harness = createHarness();
    harness.recorder.stop.mockRejectedValueOnce(new Error("stop failed"));
    await harness.controller.start();
    await harness.controller.stop();

    expect(harness.controller.currentState.phase).toBe("error");
    expect(harness.controller.currentState.error).toContain("finish voice recording");
  });

  it("ignores a late transcript after the draft owner changes", async () => {
    const transcription = deferred<string>();
    const harness = createHarness({ transcribeRecording: () => transcription.promise });
    await harness.controller.start();
    const stopping = harness.controller.stop();
    harness.setDraft(draft({ ownerKey: "environment:other-thread" }));
    transcription.resolve("late text");
    await stopping;

    expect(harness.commits).toEqual([]);
    expect(harness.controller.currentState.error).toContain("draft changed");
  });

  it("keeps the app-wide session locked until canceled native work settles", async () => {
    const preparation = deferred<string>();
    const first = createHarness({ prepareTranscription: () => preparation.promise });
    const firstStart = first.controller.start();
    first.controller.cancel();

    const blocked = createHarness();
    await blocked.controller.start();
    expect(blocked.controller.currentState.error).toContain("already active");

    preparation.resolve("en-US");
    await firstStart;
    blocked.controller.cancel();

    const next = createHarness();
    await next.controller.start();
    expect(next.controller.currentState.phase).toBe("recording");
    await next.controller.interruptRecording();
  });

  it("does not start the microphone for an owner that changed during preparation", async () => {
    const preparation = deferred<string>();
    const harness = createHarness({ prepareTranscription: () => preparation.promise });
    const starting = harness.controller.start();
    harness.setDraft(draft({ ownerKey: "environment:other-thread", text: "other draft" }));
    preparation.resolve("en-US");
    await starting;

    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.controller.currentState.error).toContain("no longer available");
  });

  it("discards native cap errors and audio interruptions without transcribing", async () => {
    const transcribeRecording = vi.fn(async () => "ignored");
    const harness = createHarness({ transcribeRecording });
    await harness.controller.start();
    harness.recorder.uri = "file:///reset-empty.m4a";
    await harness.controller.handleRecorderStatus({
      isFinished: true,
      hasError: true,
      error: "Audio route changed",
      url: "file:///voice.m4a",
      mediaServicesDidReset: true,
    });

    expect(harness.commits).toEqual([]);
    expect(transcribeRecording).not.toHaveBeenCalled();
    expect(harness.controller.currentState.error).toBe("Audio route changed");
    expect(harness.deleted).toEqual(["file:///voice.m4a", "file:///reset-empty.m4a"]);
  });

  it("cancels preparation when the app reaches the background", async () => {
    const preparation = deferred<string>();
    const harness = createHarness({ prepareTranscription: () => preparation.promise });
    const starting = harness.controller.start();
    harness.controller.appMovedToBackground();
    preparation.resolve("en-US");
    await starting;

    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.controller.currentState.error).toContain("background");
  });
});

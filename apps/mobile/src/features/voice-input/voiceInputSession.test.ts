import { beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";

const audio = vi.hoisted(() => ({
  setMode: vi.fn(async (_mode: unknown) => {}),
  setActive: vi.fn(async (_active: boolean) => {}),
}));
vi.mock("expo-audio", () => ({
  AudioModule: {},
  setAudioModeAsync: audio.setMode,
  setIsAudioActiveAsync: audio.setActive,
}));

import {
  createVoiceInputTarget,
  VoiceInputSession,
  type VoiceInputSessionDependencies,
  type VoiceInputTarget,
  type VoiceRecordingSample,
} from "./voiceInputSession";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  scheduledTaskEditorSessionAtom,
  subscribeScheduledTaskEditorReset,
  takeScheduledTaskNewLink,
  updateScheduledTaskEditor,
} from "../settings/scheduled-task-editor-state";
import { createDraft } from "../settings/scheduledTaskDraft";
import { appAtomRegistry } from "../../state/atom-registry";

function createTarget(
  ownerKey: string,
  readText: () => string | null,
  commit: VoiceInputTarget["commitDraft"],
  selection: { start: number; end: number },
) {
  return createVoiceInputTarget(ownerKey, readText, commit, selection, () => () => {});
}

function createSession(
  overrides?: Partial<
    Pick<
      VoiceInputSessionDependencies,
      "configureRecording" | "releaseRecording" | "sampleRecording"
    >
  >,
) {
  const releaseKeepAwake = vi.fn();
  const keepAwake = vi.fn(() => releaseKeepAwake);
  const publishAudioLevels = vi.fn();
  const deleteRecording = vi.fn();
  const recorder = {
    uri: "file:///voice.m4a",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const prepare = vi.fn(async (): Promise<PreparedVoiceTranscription> => ({
    locale: "en-US",
    transcribe: async () => "spoken text",
  }));
  const session = new VoiceInputSession({
    recorder,
    getTranscriber: () => ({ prepare }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: vi.fn(async () => {}),
    deleteRecording,
    sampleRecording: () => null,
    publishAudioLevels,
    keepAwake,
    ...overrides,
  });
  return {
    session,
    recorder,
    prepare,
    keepAwake,
    releaseKeepAwake,
    publishAudioLevels,
    deleteRecording,
  };
}

describe("global voice input", () => {
  beforeEach(() => resetVoiceInputGlobalsForTests());

  it.each([
    "recover",
    "reset",
    "remove",
    "new-task-link",
    "task-saved",
    "discard-new-task-link",
  ] as const)("handles retained batch audio on %s", async (action) => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());
    appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
    onTestFinished(() => appAtomRegistry.set(scheduledTaskEditorSessionAtom, null));
    const draft = Atom.make<string | null>("draft");
    const reset = Atom.make(0);
    const unsubscribeReset = vi.fn();
    const { session, recorder, prepare, deleteRecording, keepAwake } = createSession();
    const transcribe = vi
      .fn<PreparedVoiceTranscription["transcribe"]>()
      .mockRejectedValueOnce(new Error("Upload failed"))
      .mockRejectedValueOnce(new Error("Transcription failed"))
      .mockResolvedValueOnce("recovered text");
    prepare.mockResolvedValue({ locale: "en-US", transcribe });
    const commit = vi.fn();
    await session.start(
      createVoiceInputTarget(
        "first",
        () => registry.get(draft),
        commit,
        { start: 5, end: 5 },
        (onChange) => registry.subscribe(draft, onChange),
        (onReset) => {
          const stop = ["new-task-link", "task-saved", "discard-new-task-link"].includes(action)
            ? subscribeScheduledTaskEditorReset(onReset)
            : registry.subscribe(reset, onReset);
          return () => {
            stop();
            unsubscribeReset();
          };
        },
      ),
    );
    await session.controller.stop();
    expect(session.controller.currentState.phase).toBe("error");
    expect(deleteRecording).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    await session.retry();
    expect(session.controller.currentState.phase).toBe("error");
    expect(deleteRecording).not.toHaveBeenCalled();
    if (action === "recover") {
      await session.retry();
    } else {
      if (action === "new-task-link") {
        takeScheduledTaskNewLink({ routes: [{ name: "SettingsScheduledTaskNew" }] });
      } else if (action === "discard-new-task-link") {
        const editor = {
          environmentId: EnvironmentId.make("environment"),
          environmentLabel: "Environment",
          draft: createDraft(null, null),
        };
        updateScheduledTaskEditor(
          { ...editor, draft: { ...editor.draft, prompt: "typed" } },
          editor,
        );
        takeScheduledTaskNewLink({ routes: [{ name: "SettingsScheduledTaskNew" }] });
        expect(session.controller.currentState.phase).toBe("error");
        expect(deleteRecording).not.toHaveBeenCalled();
        discardScheduledTaskEditor();
      } else if (action === "task-saved") {
        markScheduledTaskEditorSaved();
      } else if (action === "reset") registry.set(reset, 1);
      else registry.set(draft, null);
      expect(session.controller.currentState.phase).toBe("idle");
      expect(deleteRecording).toHaveBeenCalledExactlyOnceWith("file:///voice.m4a");
      expect(commit).not.toHaveBeenCalled();
      await session.start(createTarget("first", () => "draft", commit, { start: 5, end: 5 }));
      await session.controller.stop();
    }
    expect(session.controller.currentState.phase).toBe("idle");
    expect(transcribe.mock.calls.map(([uri]) => uri)).toEqual([
      "file:///voice.m4a",
      "file:///voice.m4a",
      "file:///voice.m4a",
    ]);
    expect(recorder.record).toHaveBeenCalledTimes(action === "recover" ? 1 : 2);
    expect(keepAwake).toHaveBeenCalledTimes(action === "recover" ? 1 : 2);
    expect(commit).toHaveBeenCalledExactlyOnceWith("draft recovered text", {
      start: 20,
      end: 20,
    });
    expect(deleteRecording).toHaveBeenCalledTimes(action === "recover" ? 1 : 2);
    expect(unsubscribeReset).toHaveBeenCalledTimes(action === "recover" ? 3 : 2);
  });

  it.each(["retry", "takeover"])(
    "handles failed deactivation with %s without notifying a released owner",
    async (action) => {
      const pause = vi.fn();
      const playback = acquireAudioSession("recording", pause);
      await activateAudioSession(playback);
      audio.setActive.mockRejectedValueOnce(new Error("Deactivation failed"));
      await expect(releaseAudioSession(playback)).rejects.toThrow("Deactivation failed");
      if (action === "retry") {
        await releaseAudioSession(playback);
        expect(audio.setActive).toHaveBeenLastCalledWith(false);
      }
      const recording = acquireAudioSession("recording");
      expect(pause).not.toHaveBeenCalled();
      await releaseAudioSession(recording);
      vi.clearAllMocks();
    },
  );

  it.each(["complete", "activation failure"])(
    "protects recording from inline playback and releases its session after %s",
    async (outcome) => {
      const pause = vi.fn();
      const playback = acquireAudioSession("playback", pause);
      await activateAudioSession(playback);
      let recording!: ReturnType<typeof acquireAudioSession>;
      const { session, recorder } = createSession({
        configureRecording: async () => {
          recording = acquireAudioSession("recording");
          try {
            await activateAudioSession(recording);
          } catch (error) {
            await releaseAudioSession(recording);
            throw error;
          }
        },
        releaseRecording: () => releaseAudioSession(recording),
      });
      if (outcome === "activation failure") {
        audio.setActive.mockRejectedValueOnce(new Error("Audio activation failed"));
      }
      await session.start(createTarget("first", () => "", vi.fn(), { start: 0, end: 0 }));
      expect(pause).toHaveBeenCalledOnce();
      expect(isAudioSessionOwner(playback)).toBe(false);
      if (outcome === "complete") {
        expect(recorder.record).toHaveBeenCalledOnce();
        expect(session.controller.currentState.phase).toBe("recording");
        audio.setMode.mockClear();
        audio.setActive.mockClear();
        await releaseAudioSession(playback);
        const blockedPlayback = acquireAudioSession("playback");
        expect(await activateAudioSession(blockedPlayback)).toBe(false);
        await releaseAudioSession(blockedPlayback);
        expect(audio.setMode).not.toHaveBeenCalled();
        expect(audio.setActive).not.toHaveBeenCalled();
        expect(isAudioSessionOwner(recording)).toBe(true);
        await session.controller.stop();
      } else {
        expect(recorder.record).not.toHaveBeenCalled();
        expect(session.controller.currentState.phase).toBe("error");
      }
      expect(audio.setActive).toHaveBeenLastCalledWith(false);
      expect(isAudioSessionOwner(recording)).toBe(false);
      const replay = acquireAudioSession("playback");
      expect(await activateAudioSession(replay)).toBe(true);
      expect(audio.setActive).toHaveBeenLastCalledWith(true);
      await releaseAudioSession(replay);
      vi.clearAllMocks();
    },
  );

  it.each([
    { selection: { start: 6, end: 11 }, expected: "hello spoken text", cursor: 17 },
    { selection: { start: 6, end: 6 }, expected: "hello spoken text world", cursor: 18 },
  ])(
    "keeps the starting selection $selection after navigation",
    async ({ selection, expected, cursor }) => {
      const { session } = createSession();
      const commit = vi.fn();
      await session.start(createTarget("first", () => "hello world", commit, selection));
      await session.start(
        createTarget("second", () => "other prompt", vi.fn(), { start: 12, end: 12 }),
      );
      await session.controller.stop();
      expect(commit).toHaveBeenCalledWith(expected, {
        start: cursor,
        end: cursor,
      });
    },
  );

  it("appends to the starting draft after its screen leaves and another draft opens", async () => {
    const { session, recorder } = createSession();
    const drafts = new Map([
      ["first", "original prompt"],
      ["second", "other prompt"],
    ]);
    let visibleDraft = "first";
    const targetKey = visibleDraft;
    await session.start(
      createTarget(
        targetKey,
        () => drafts.get(targetKey) ?? null,
        (text) => drafts.set(targetKey, text),
        { start: 15, end: 15 },
      ),
    );
    visibleDraft = "second";
    expect(session.controller.currentState.phase).toBe("recording");
    expect(recorder.stop).not.toHaveBeenCalled();
    await session.controller.stop();

    expect(drafts.get("first")).toBe("original prompt spoken text");
    expect(drafts.get(visibleDraft)).toBe("other prompt");
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it.each(["preparing", "recording", "transcribing"] as const)(
    "keeps one recorder and its original target during %s",
    async (phase) => {
      const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
      const preparationEntered = Promise.withResolvers<void>();
      const transcription = Promise.withResolvers<string>();
      const transcriptionEntered = Promise.withResolvers<void>();
      const { session, recorder, prepare } = createSession();
      prepare.mockImplementationOnce(() => {
        preparationEntered.resolve();
        return preparation.promise;
      });
      const firstCommit = vi.fn();
      const secondCommit = vi.fn();
      const starting = session.start(
        createTarget("first", () => "first", firstCommit, { start: 5, end: 5 }),
      );
      await preparationEntered.promise;
      let stopping: Promise<void> | null = null;
      if (phase !== "preparing") {
        preparation.resolve({
          locale: "en-US",
          transcribe: () => {
            transcriptionEntered.resolve();
            return transcription.promise;
          },
        });
        await starting;
      }
      if (phase === "transcribing") {
        stopping = session.controller.stop();
        await transcriptionEntered.promise;
      }
      await session.start(
        createTarget("second", () => "second", secondCommit, { start: 6, end: 6 }),
      );
      expect(session.ownerKey).toBe("first");
      expect(session.controller.currentState.phase).toBe(phase);
      expect(prepare).toHaveBeenCalledTimes(1);
      preparation.resolve({ locale: "en-US", transcribe: async () => "spoken text" });
      await starting;
      transcription.resolve("spoken text");
      await (stopping ?? session.controller.stop());
      expect(recorder.record).toHaveBeenCalledTimes(1);
      expect(firstCommit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
      expect(secondCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["changed", "removed"] as const)(
    "does not overwrite a %s starting draft",
    async (change) => {
      const { session } = createSession();
      let text: string | null = "first";
      const commit = vi.fn();
      await session.start(createTarget("first", () => text, commit, { start: 5, end: 5 }));
      text = change === "removed" ? null : "edited prompt";
      await session.controller.stop();
      expect(commit).not.toHaveBeenCalled();
      expect(session.controller.currentState.error).toContain("draft changed");
    },
  );

  it("finishes the original draft at the recording limit while it is off screen", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(createTarget("first", () => "first", commit, { start: 5, end: 5 }));
    await session.controller.handleRecorderStatus({
      isFinished: true,
      hasError: false,
      error: null,
      url: recorder.uri,
    });
    expect(commit).toHaveBeenCalledWith("first spoken text", { start: 17, end: 17 });
    expect(session.controller.currentState.phase).toBe("idle");
  });

  it("rejects a transcript when its off-screen draft changes and returns to the original text", async () => {
    const registry = AtomRegistry.make();
    const draft = Atom.make("hello world");
    const unsubscribe = vi.fn();
    const { session } = createSession();
    const commit = vi.fn();
    const target = createVoiceInputTarget(
      "first",
      () => registry.get(draft),
      commit,
      { start: 6, end: 6 },
      (onChange) => {
        const stop = registry.subscribe(draft, onChange);
        return () => {
          stop();
          unsubscribe();
        };
      },
    );
    await session.start(target);
    registry.set(draft, "changed");
    registry.set(draft, "hello world");
    await session.controller.stop();
    expect(commit).not.toHaveBeenCalled();
    expect(session.controller.currentState.error).toContain("draft changed");
    session.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("stops recording when its queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    let draft: string | null = "queued prompt";
    const ownerKey = "thread~queued-edit~run";
    await session.start(createTarget(ownerKey, () => draft, commit, { start: 13, end: 13 }));
    session.cancel(ownerKey);
    draft = null;
    await session.controller.stop();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(session.controller.currentState).toEqual({
      phase: "idle",
      error: null,
      errorAction: null,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps another prompt's recording when a queued edit is discarded", async () => {
    const { session, recorder } = createSession();
    const commit = vi.fn();
    await session.start(createTarget("other prompt", () => "hello", commit, { start: 5, end: 5 }));
    session.cancel("thread~queued-edit~run");
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(session.controller.currentState.phase).toBe("recording");
    await session.controller.stop();
    expect(commit).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
  });

  it("waits for canceled native work before starting a recording for another draft", async () => {
    const preparation = Promise.withResolvers<PreparedVoiceTranscription>();
    const preparationEntered = Promise.withResolvers<void>();
    const { session, recorder, prepare } = createSession();
    prepare.mockImplementationOnce(() => {
      preparationEntered.resolve();
      return preparation.promise;
    });
    const oldCommit = vi.fn();
    const nextCommit = vi.fn();
    const firstStart = session.start(
      createTarget("first", () => "first", oldCommit, { start: 5, end: 5 }),
    );
    await preparationEntered.promise;
    session.cancel("first");
    const nextStart = session.start(
      createTarget("second", () => "second", nextCommit, { start: 6, end: 6 }),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(recorder.record).not.toHaveBeenCalled();
    preparation.resolve({ locale: "en-US", transcribe: async () => "old transcript" });
    await firstStart;
    await nextStart;
    await session.controller.stop();
    expect(recorder.record).toHaveBeenCalledTimes(1);
    expect(oldCommit).not.toHaveBeenCalled();
    expect(nextCommit).toHaveBeenCalledWith("second spoken text", { start: 18, end: 18 });
  });

  it("holds the screen awake and meters only while recording", async () => {
    vi.useFakeTimers();
    try {
      let sample: VoiceRecordingSample = { durationMillis: 0, metering: -100 };
      const { session, keepAwake, releaseKeepAwake, publishAudioLevels } = createSession({
        sampleRecording: () => sample,
      });
      const snapshots: number[] = [];
      session.subscribe(() => snapshots.push(session.getSnapshot().elapsedSeconds));

      await session.start(createTarget("first", () => "first", vi.fn(), { start: 5, end: 5 }));
      expect(session.getSnapshot().state.phase).toBe("recording");
      expect(keepAwake).toHaveBeenCalledTimes(1);
      // Silence on a silent history publishes nothing.
      expect(publishAudioLevels).not.toHaveBeenCalled();

      sample = { durationMillis: 2_400, metering: 0 };
      vi.advanceTimersByTime(80);
      expect(session.getSnapshot().elapsedSeconds).toBe(2);
      expect(publishAudioLevels).toHaveBeenLastCalledWith(expect.arrayContaining([1]));

      await session.controller.stop();
      expect(releaseKeepAwake).toHaveBeenCalledTimes(1);
      const publishedLevels = publishAudioLevels.mock.calls.length;
      const publishedSnapshots = snapshots.length;
      vi.advanceTimersByTime(800);
      expect(publishAudioLevels).toHaveBeenCalledTimes(publishedLevels);
      expect(snapshots).toHaveLength(publishedSnapshots);
      // The finished recording's time stays readable until the next one starts.
      expect(session.getSnapshot().elapsedSeconds).toBe(2);

      sample = { durationMillis: 0, metering: -100 };
      await session.start(createTarget("first", () => "first", vi.fn(), { start: 5, end: 5 }));
      expect(session.getSnapshot().elapsedSeconds).toBe(0);
      expect(publishAudioLevels).toHaveBeenLastCalledWith(expect.not.arrayContaining([1]));
      expect(keepAwake).toHaveBeenCalledTimes(2);
      session.dispose();
      expect(releaseKeepAwake).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes which owners are focused", () => {
    const { session } = createSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.setOwnerFocused("first", true);
    session.setOwnerFocused("first", true);
    expect(session.getSnapshot().focusedOwners).toEqual(new Set(["first"]));
    expect(listener).toHaveBeenCalledTimes(1);
    session.setOwnerFocused("first", false);
    expect(session.getSnapshot().focusedOwners.size).toBe(0);
  });
});

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";

const FIXED_NOW = Date.UTC(2026, 10, 25, 22, 0, 0);

const mocks = vi.hoisted(() => ({
  appState: "active",
  appStateListeners: new Set<(state: string) => void>(),
  files: new Map<string, string>(),
  drafts: new Map<
    string,
    {
      text: string;
      project?: { environmentId: EnvironmentId; projectId: ProjectId; createdAt: string };
    }
  >(),
  rememberedSelections: [] as Array<{
    draftKey: string;
    text: string;
    selection: { start: number; end: number };
  }>,
  explicitGrantChoice: false,
  storedGrantValue: null as { id: string } | null,
  draftsLoadedGate: null as Promise<void> | null,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-reanimated", () => ({ makeMutable: () => ({ set() {} }) }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    textSync() {
      const value = mocks.files.get(this.uri);
      if (value === undefined) throw new Error(`ENOENT: ${this.uri}`);
      return value;
    }
    writeSync(contents: string) {
      mocks.files.set(this.uri, contents);
    }
    delete() {
      mocks.files.delete(this.uri);
    }
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: async () => {},
}));
vi.mock("expo-audio", () => ({
  AudioModule: {
    AudioRecorder: class {
      uri = "file:///cache/env-voice.m4a";
      prepareToRecordAsync = vi.fn(async () => {});
      record = vi.fn();
      stop = vi.fn(async () => {});
      getStatus = () => ({
        canRecord: true,
        isRecording: false,
        durationMillis: 0,
        fileSize: 0,
        mediaServicesDidReset: false,
        url: null,
      });
      addListener = () => ({ remove() {} });
      getAvailableInputs = () => [];
      setInput = vi.fn();
      release = vi.fn();
    },
  },
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("../../native/voiceRecorder", () => ({ createVoiceRecorder: vi.fn() }));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: async () => null }));
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.initial()) };
});
vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {
    if (mocks.draftsLoadedGate) await mocks.draftsLoadedGate;
  },
  getComposerDraftSnapshot: (draftKey: string) => mocks.drafts.get(draftKey) ?? { text: "" },
  setComposerDraftText: (draftKey: string, value: string) => {
    const existing = mocks.drafts.get(draftKey);
    mocks.drafts.set(draftKey, { ...existing, text: value });
  },
  updateComposerDraftSettings: (
    draftKey: string,
    patch: {
      project?: { environmentId: EnvironmentId; projectId: ProjectId; createdAt: string };
    },
  ) => {
    const existing = mocks.drafts.get(draftKey) ?? { text: "" };
    mocks.drafts.set(draftKey, { ...existing, ...patch });
  },
  rememberComposerDraftSelection: (
    draftKey: string,
    text: string,
    selection: { start: number; end: number },
  ) => {
    mocks.rememberedSelections.push({ draftKey, text, selection });
  },
}));
vi.mock("./voiceDestination", async () => {
  const { Atom } = await import("effect/reactivity");
  const voiceGrantAtom = Atom.make<{ id: string } | null>(null);
  const voiceRouteAtom = Atom.make<{ transcriber: VoiceTranscriber | null } | null>(null);
  return {
    voiceGrantAtom,
    voiceRouteAtom,
    hasExplicitVoiceGrantChoice: () => mocks.explicitGrantChoice,
    waitForVoiceGrantLoaded: async (registry: AtomRegistry.AtomRegistry) => {
      if (!mocks.explicitGrantChoice && mocks.storedGrantValue !== null) {
        registry.set(voiceGrantAtom, mocks.storedGrantValue);
      }
      return registry.get(voiceGrantAtom);
    },
  };
});

import { setAudioModeAsync } from "expo-audio";
import type { MicrophoneEntry } from "../../lib/microphonePriority";
import { createVoiceRecorder } from "../../native/voiceRecorder";
import { mobilePreferencesAtom } from "../../state/preferences";
import { voiceGrantAtom, voiceRouteAtom } from "./voiceDestination";
import { localVoiceTranscriberAtom, voiceInputAtom } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";
import { writePendingVoiceRecording } from "./pendingVoiceRecording";

function emitAppState(state: string) {
  mocks.appState = state;
  for (const listener of mocks.appStateListeners) listener(state);
}

function mockNativeRecorder(uri = "file:///cache/voice.m4a") {
  const stop = vi.fn(async () => {
    mocks.files.set(uri, "m4a-bytes");
  });
  const setInput = vi.fn();
  vi.mocked(createVoiceRecorder, { partial: true }).mockReturnValue({
    uri,
    prepareToRecordAsync: async () => {},
    record() {},
    stop,
    getStatus: () => ({
      canRecord: true,
      isRecording: false,
      durationMillis: 0,
      fileSize: 0,
      mediaServicesDidReset: false,
      url: null,
    }),
    addListener: () => ({ remove() {} }),
    getAvailableInputs: () => [{ uid: "iphone", name: "iPhone", type: "MicrophoneBuiltIn" }],
    setInput,
    release() {},
  });
  return { stop, setInput };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  resetVoiceInputGlobalsForTests();
  mocks.appState = "active";
  mocks.appStateListeners.clear();
  mocks.files.clear();
  mocks.drafts.clear();
  mocks.rememberedSelections.length = 0;
  mocks.explicitGrantChoice = false;
  mocks.storedGrantValue = null;
  mocks.draftsLoadedGate = null;
  vi.mocked(setAudioModeAsync).mockReset();
  vi.mocked(setAudioModeAsync).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

it("uses the loaded microphone order when recording starts before preferences hydrate", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  // Startup either subscribes to pending preferences or activates audio before they load.
  const startup = Promise.withResolvers<void>();
  vi.mocked(setAudioModeAsync).mockImplementation(async () => startup.resolve());
  const { setInput } = mockNativeRecorder("file:///voice.m4a");
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "" }),
  });
  const { session } = registry.get(voiceInputAtom);
  const subscribe = registry.subscribe.bind(registry);
  using _subscribe = vi
    .spyOn(registry, "subscribe")
    .mockImplementation((atom, listener, options) => {
      if (atom === preferences) startup.resolve();
      return subscribe(atom, listener, options);
    });
  try {
    const start = session.start(
      createVoiceInputTarget("draft", () => "", vi.fn(), { start: 0, end: 0 }),
    );
    await startup.promise;
    registry.set(
      preferences,
      AsyncResult.success({
        microphones: [
          { kind: "builtIn" },
          { kind: "wired" },
          { kind: "bluetooth" },
          { kind: "carPlay" },
        ],
      }),
    );
    await start;
    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: true, allowBluetoothRecording: false }),
    );
    expect(setInput).toHaveBeenCalledWith("iphone");
  } finally {
    session.controller.cancel();
    registry.dispose();
  }
});

it("preserves spoken audio across switching to another app and transcribes on return", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  registry.set(preferences, AsyncResult.success({ microphones: [] }));
  const { stop } = mockNativeRecorder("file:///cache/voice.m4a");
  const transcribe = vi.fn(async () => "saved before camera");
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", start: async () => null, transcribe }),
  });
  const { session } = registry.get(voiceInputAtom);
  const committed = vi.fn();
  try {
    await session.start({
      ...createVoiceInputTarget("env:thread-1", () => "prompt", committed, { start: 6, end: 6 }),
      label: "My thread",
      persistent: true,
    });
    expect(session.controller.currentState.phase).toBe("recording");

    emitAppState("background");
    await vi.waitFor(() =>
      expect(mocks.files.has("file:///cache/voice-pending-recording.json")).toBe(true),
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    expect(mocks.files.has("file:///cache/voice.m4a")).toBe(true);

    emitAppState("active");
    await vi.waitFor(() => expect(committed).toHaveBeenCalledOnce());
    expect(committed).toHaveBeenCalledWith("prompt saved before camera", {
      start: 26,
      end: 26,
    });
    expect(mocks.files.has("file:///cache/voice.m4a")).toBe(false);
    expect(mocks.files.has("file:///cache/voice-pending-recording.json")).toBe(false);
  } finally {
    registry.dispose();
  }
});

it("recovers a saved recording into its persisted draft after an OS kill", async () => {
  const registry = AtomRegistry.make();
  const uri = "file:///cache/recovered.m4a";
  mocks.files.set(uri, "m4a-bytes");
  mocks.drafts.set("env:thread-1", { text: "existing" });
  writePendingVoiceRecording({
    uri,
    ownerKey: "env:thread-1",
    label: "My thread",
    startText: "existing",
    selection: { start: 8, end: 8 },
    grantId: null,
    recordedAt: FIXED_NOW,
  });
  const transcribe = vi.fn(async () => "recovered after kill");
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe }),
  });
  const { session } = registry.get(voiceInputAtom);
  try {
    await vi.waitFor(() =>
      expect(mocks.drafts.get("env:thread-1")?.text).toBe("existing recovered after kill"),
    );
    expect(transcribe).toHaveBeenCalledWith(uri, { signal: expect.any(AbortSignal) });
    expect(mocks.rememberedSelections).toEqual([
      {
        draftKey: "env:thread-1",
        text: "existing recovered after kill",
        selection: { start: 29, end: 29 },
      },
    ]);
    expect(mocks.files.has(uri)).toBe(false);
    expect(mocks.files.has("file:///cache/voice-pending-recording.json")).toBe(false);
    expect(session.controller.currentState.phase).toBe("idle");
  } finally {
    registry.dispose();
  }
});

it("restores project metadata when recovering an empty new-task draft after an OS kill", async () => {
  const registry = AtomRegistry.make();
  const uri = "file:///cache/new-task.m4a";
  const draftKey = "new-task:draft-1";
  const project = {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("proj-1"),
    createdAt: "2026-11-25T22:00:00.000Z",
  };
  mocks.files.set(uri, "m4a-bytes");
  mocks.storedGrantValue = { id: "env-grant-1" };
  const routeAtom = voiceRouteAtom as Atom.Writable<
    { transcriber: VoiceTranscriber | null } | null,
    { transcriber: VoiceTranscriber | null } | null
  >;
  const transcribe = vi.fn(async () => "first prompt");
  registry.set(routeAtom, {
    transcriber: { prepare: async () => ({ locale: "en-US", transcribe }) },
  });
  writePendingVoiceRecording({
    uri,
    ownerKey: draftKey,
    label: "New task",
    startText: "",
    selection: { start: 0, end: 0 },
    grantId: "env-grant-1",
    recordedAt: FIXED_NOW,
    project,
  });
  registry.get(voiceInputAtom);
  try {
    await vi.waitFor(() =>
      expect(mocks.drafts.get(draftKey)).toEqual({ text: "first prompt", project }),
    );
    expect(mocks.files.size).toBe(0);
  } finally {
    registry.dispose();
  }
});

it("cleans up an orphaned saved recording if the user starts dictating before hydration finishes", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  registry.set(preferences, AsyncResult.success({ microphones: [] }));
  const oldUri = "file:///cache/old-pending.m4a";
  mocks.files.set(oldUri, "old-bytes");
  mocks.drafts.set("env:thread-1", { text: "existing" });
  const gate = Promise.withResolvers<void>();
  mocks.draftsLoadedGate = gate.promise;
  writePendingVoiceRecording({
    uri: oldUri,
    ownerKey: "env:thread-1",
    label: "My thread",
    startText: "existing",
    selection: { start: 8, end: 8 },
    grantId: null,
    recordedAt: FIXED_NOW,
  });
  mockNativeRecorder("file:///cache/new-recording.m4a");
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "new" }),
  });
  const { session } = registry.get(voiceInputAtom);
  try {
    await session.start(
      createVoiceInputTarget("env:thread-2", () => "", vi.fn(), { start: 0, end: 0 }),
    );
    gate.resolve();
    await vi.waitFor(() => expect(mocks.files.has(oldUri)).toBe(false));
    expect(session.controller.currentState.phase).toBe("recording");
  } finally {
    session.controller.cancel();
    registry.dispose();
  }
});

it("discards a saved recording on launch when its transcription grant no longer matches", async () => {
  const registry = AtomRegistry.make();
  const uri = "file:///cache/revoked.m4a";
  mocks.files.set(uri, "m4a-bytes");
  mocks.drafts.set("env:thread-1", { text: "existing" });
  writePendingVoiceRecording({
    uri,
    ownerKey: "env:thread-1",
    label: "My thread",
    startText: "existing",
    selection: { start: 8, end: 8 },
    grantId: "old-grant",
    recordedAt: FIXED_NOW,
  });
  const transcribe = vi.fn(async () => "must not send");
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe }),
  });
  registry.get(voiceInputAtom);
  try {
    await vi.waitFor(() => expect(mocks.files.size).toBe(0));
    expect(transcribe).not.toHaveBeenCalled();
    expect(mocks.drafts.get("env:thread-1")?.text).toBe("existing");
  } finally {
    registry.dispose();
  }
});

it("preserves audio when the environment disconnects during recording and transcribes on reconnect", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  registry.set(preferences, AsyncResult.success({ microphones: [] }));
  const grantAtom = voiceGrantAtom as Atom.Writable<{ id: string } | null, { id: string } | null>;
  const routeAtom = voiceRouteAtom as Atom.Writable<
    { transcriber: VoiceTranscriber | null } | null,
    { transcriber: VoiceTranscriber | null } | null
  >;
  mocks.explicitGrantChoice = true;
  registry.set(grantAtom, { id: "env-grant-1" });
  const staleTranscribe = vi.fn(async () => {
    throw Object.assign(new Error("Your transcription choice changed."), { code: "cancelled" });
  });
  const freshTranscribe = vi.fn(async () => "saved across disconnect");
  registry.set(routeAtom, {
    transcriber: {
      prepare: async () => ({
        locale: "en-US",
        start: async () => null,
        transcribe: staleTranscribe,
      }),
    },
  });
  const { session } = registry.get(voiceInputAtom);
  const committed = vi.fn();
  try {
    await session.start({
      ...createVoiceInputTarget("env:thread-1", () => "draft", committed, { start: 5, end: 5 }),
      persistent: true,
    });
    registry.set(routeAtom, { transcriber: null });
    await vi.waitFor(() => expect(session.controller.currentState.phase).toBe("transcribing"));

    registry.set(routeAtom, {
      transcriber: {
        prepare: async () => ({ locale: "en-US", transcribe: freshTranscribe }),
      },
    });
    await vi.waitFor(() =>
      expect(committed).toHaveBeenCalledWith("draft saved across disconnect", {
        start: 29,
        end: 29,
      }),
    );
  } finally {
    registry.dispose();
  }
});

it("keeps a backgrounded environment recording across a transient disconnect and revokes it on grant change", async () => {
  const registry = AtomRegistry.make();
  const preferences = mobilePreferencesAtom as Atom.Writable<
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>,
    AsyncResult.AsyncResult<{ microphones: ReadonlyArray<MicrophoneEntry> }>
  >;
  registry.set(preferences, AsyncResult.success({ microphones: [] }));
  const grantAtom = voiceGrantAtom as Atom.Writable<{ id: string } | null, { id: string } | null>;
  const routeAtom = voiceRouteAtom as Atom.Writable<
    { transcriber: VoiceTranscriber | null } | null,
    { transcriber: VoiceTranscriber | null } | null
  >;
  const grant = { id: "env-grant-1" };
  mocks.explicitGrantChoice = true;
  registry.set(grantAtom, grant);
  const staleTranscribe = vi.fn(async () => {
    const error = Object.assign(new Error("Connection changed"), { code: "cancelled" });
    throw error;
  });
  const freshTranscribe = vi.fn(async () => "reconnected text");
  registry.set(routeAtom, {
    transcriber: {
      prepare: async () => ({
        locale: "en-US",
        start: async () => null,
        transcribe: staleTranscribe,
      }),
    },
  });
  const { session } = registry.get(voiceInputAtom);
  const committed = vi.fn();
  try {
    await session.start({
      ...createVoiceInputTarget("env:thread-1", () => "draft", committed, { start: 5, end: 5 }),
      persistent: true,
    });
    emitAppState("background");
    await vi.waitFor(() => expect(session.controller.currentState.phase).toBe("transcribing"));

    // Transient disconnect while backgrounded must not cancel or delete the saved recording.
    registry.set(routeAtom, { transcriber: null });
    expect(session.controller.currentState.phase).toBe("transcribing");

    emitAppState("active");
    registry.set(routeAtom, {
      transcriber: {
        prepare: async () => ({ locale: "en-US", transcribe: freshTranscribe }),
      },
    });
    await vi.waitFor(() =>
      expect(committed).toHaveBeenCalledWith("draft reconnected text", {
        start: 22,
        end: 22,
      }),
    );

    // Explicit grant revocation cancels active recording and deletes any saved audio.
    await session.start({
      ...createVoiceInputTarget("env:thread-1", () => "draft", committed, { start: 5, end: 5 }),
      persistent: true,
    });
    mocks.files.set("file:///cache/env-voice.m4a", "m4a-bytes");
    emitAppState("background");
    await vi.waitFor(() =>
      expect(mocks.files.has("file:///cache/voice-pending-recording.json")).toBe(true),
    );
    registry.set(grantAtom, null);
    await vi.waitFor(() => expect(session.controller.currentState.phase).toBe("idle"));
    expect(mocks.files.size).toBe(0);
  } finally {
    registry.dispose();
  }
});

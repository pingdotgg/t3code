import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  models: [
    {
      id: "handy-computer/parakeet-ultra-gguf",
      name: "Parakeet Ultra",
      description: "Multilingual dictation",
      size: 740_363_168,
      languages: ["uk", "en"],
    },
    {
      id: "handy-computer/whisper-small-gguf",
      name: "Whisper Small",
      description: "Multilingual dictation",
      size: 269_751_136,
      languages: ["uk", "en"],
    },
    {
      id: "handy-computer/whisper-large-v3-gguf",
      name: "Whisper Large v3",
      description: "Multilingual dictation",
      size: 1_575_200_000,
      languages: ["uk", "en"],
      canRun: false,
    },
  ] as const,
  snapshot: vi.fn<() => Promise<unknown>>(),
  listen: vi.fn<(name: string, listener: (snapshot: unknown) => void) => { remove(): void }>(
    () => ({ remove() {} }),
  ),
  transcribe:
    vi.fn<
      (modelId: string, id: string, uri: string) => Promise<{ text: string; language?: string }>
    >(),
  cancel: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    getDeviceSpeechCatalog: () => native.models,
    getDeviceSpeechModelStates: native.snapshot,
    addListener: native.listen,
    transcribeWithDeviceSpeechModel: native.transcribe,
    cancelDeviceSpeechInference: native.cancel,
  }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock("react-native-reanimated", () => ({ makeMutable: () => ({ set() {} }) }));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: async () => {},
}));
vi.mock("expo-audio", () => ({
  AudioModule: {},
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: async () => ({ granted: true }),
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-voice-request" }));
vi.mock("../../native/voiceRecorder", () => ({ createVoiceRecorder: vi.fn() }));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: async () => null }));
vi.mock("../../state/preferences", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.initial()) };
});
vi.mock("./voiceDestination", async () => {
  const { Atom } = await import("effect/reactivity");
  return { voiceRouteAtom: Atom.make(null) };
});

import { setAudioModeAsync } from "expo-audio";
import {
  deviceSpeechModelStatesAtom,
  deviceSpeechTranscriber,
} from "../../native/deviceSpeechModels";
import { createVoiceRecorder } from "../../native/voiceRecorder";
import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  localVoiceTranscriberAtom,
  voiceInputAtom,
  voiceInputAvailableAtom,
} from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const preferences = mobilePreferencesAtom as Atom.Writable<
  AsyncResult.AsyncResult<Preferences>,
  AsyncResult.AsyncResult<Preferences>
>;
const [parakeet, whisper, largeWhisper] = native.models;

function modelSnapshot(revision: number, first: "ready" | "missing") {
  return {
    revision,
    states: { [parakeet.id]: { kind: first }, [whisper.id]: { kind: "ready" } },
  };
}

function mockRecorder() {
  const setInput = vi.fn();
  vi.mocked(createVoiceRecorder, { partial: true }).mockReturnValue({
    uri: "file:///voice.m4a",
    prepareToRecordAsync: async () => {},
    record() {},
    stop: async () => {},
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
  return setInput;
}

it("uses the loaded microphone order when recording starts before preferences hydrate", async () => {
  const registry = AtomRegistry.make();
  const preferencesSubscribedOrAudioModeSet = Promise.withResolvers<void>();
  vi.mocked(setAudioModeAsync).mockImplementation(async () =>
    preferencesSubscribedOrAudioModeSet.resolve(),
  );
  const setInput = mockRecorder();
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "" }),
  });
  const { session } = registry.get(voiceInputAtom);
  const subscribe = registry.subscribe.bind(registry);
  using _subscribe = vi
    .spyOn(registry, "subscribe")
    .mockImplementation((atom, listener, options) => {
      if (atom === preferences) preferencesSubscribedOrAudioModeSet.resolve();
      return subscribe(atom, listener, options);
    });
  try {
    const start = session.start(
      createVoiceInputTarget("draft", () => "", vi.fn(), { start: 0, end: 0 }),
    );
    await preferencesSubscribedOrAudioModeSet.promise;
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
    await session.controller.cancel();
    registry.dispose();
  }
});

it("keeps the chosen model for the recording, then uses the next selection", async () => {
  const registry = AtomRegistry.make();
  mockRecorder();
  native.snapshot.mockResolvedValue(modelSnapshot(1, "ready"));
  native.transcribe.mockImplementation(async (modelId) =>
    modelId === parakeet.id ? { text: "Світ.", language: "uk" } : { text: "Hi.", language: "en" },
  );
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "Hello." }),
  });
  const { session } = registry.get(voiceInputAtom);
  const hydrating = Promise.withResolvers<void>();
  const subscribe = registry.subscribe.bind(registry);
  using _subscribe = vi
    .spyOn(registry, "subscribe")
    .mockImplementation((atom, listener, options) => {
      if (atom === preferences) hydrating.resolve();
      return subscribe(atom, listener, options);
    });
  const commit = vi.fn();
  const target = createVoiceInputTarget("draft", () => "", commit, { start: 0, end: 0 });
  const ukrainianDraft = createVoiceInputTarget("draft", () => "Вітаю", commit, {
    start: 5,
    end: 5,
  });
  try {
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);
    const start = session.start(ukrainianDraft);
    await hydrating.promise;
    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: parakeet.id }));
    await start;
    expect(session.controller.currentState.phase).toBe("recording");
    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: whisper.id }));
    await session.controller.stop();
    expect(commit.mock.calls.map(([text]) => text)).toEqual(["Вітаю Світ."]);

    await session.start(target);
    await session.controller.stop();
    expect(commit.mock.calls.map(([text]) => text)).toEqual(["Вітаю Світ.", "Hi."]);
    expect(native.transcribe.mock.calls.slice(-2).map(([id]) => id)).toEqual([
      parakeet.id,
      whisper.id,
    ]);

    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: null }));
    await session.start(target);
    await session.controller.stop();
    expect(commit.mock.lastCall?.[0]).toEqual("Hello.");
  } finally {
    session.controller.cancel();
    registry.dispose();
  }
});

it("keeps a removed selection unavailable until a different model or Apple Speech is chosen", async () => {
  const registry = AtomRegistry.make();
  const initial = Promise.withResolvers<unknown>();
  native.snapshot.mockReturnValue(initial.promise);
  registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: parakeet.id }));
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "Hello." }),
  });
  try {
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);
    const emit = native.listen.mock.lastCall?.[1];
    expect(emit).toBeDefined();
    emit?.(modelSnapshot(2, "ready"));
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
    initial.resolve(modelSnapshot(1, "missing"));
    await initial.promise;
    expect(registry.get(deviceSpeechModelStatesAtom)).toMatchObject({
      kind: "ready",
      states: modelSnapshot(2, "ready").states,
    });

    emit?.(modelSnapshot(3, "missing"));
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);
    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: whisper.id }));
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: null }));
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
  } finally {
    registry.dispose();
  }
});

it("keeps an installed model unavailable for dictation when it exceeds the memory budget", () => {
  const registry = AtomRegistry.make();
  native.snapshot.mockResolvedValue(modelSnapshot(1, "ready"));
  registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: largeWhisper.id }));
  try {
    registry.get(deviceSpeechModelStatesAtom);
    native.listen.mock.lastCall?.[1]({
      revision: 2,
      states: { [largeWhisper.id]: { kind: "ready" }, [whisper.id]: { kind: "ready" } },
    });
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);

    registry.set(preferences, AsyncResult.success({ deviceVoiceModelId: whisper.id }));
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
  } finally {
    registry.dispose();
  }
});

it("discards a cancelled local transcript after the native operation settles", async () => {
  native.snapshot.mockResolvedValue(modelSnapshot(1, "ready"));
  const recording = Promise.withResolvers<{ text: string }>();
  native.transcribe.mockReturnValue(recording.promise);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const prepared = await deviceSpeechTranscriber(parakeet).prepare(options);
  const result = prepared.transcribe("file:///voice.m4a", options);
  const id = native.transcribe.mock.lastCall?.[1];
  controller.abort();
  expect(native.cancel).toHaveBeenCalledWith(id);
  recording.resolve({ text: "Late transcript." });
  await expect(result).rejects.toMatchObject({ code: "cancelled" });
});

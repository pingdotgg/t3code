import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  snapshot: vi.fn<() => Promise<unknown>>(),
  listen: vi.fn<(name: string, listener: (snapshot: unknown) => void) => { remove(): void }>(
    () => ({ remove() {} }),
  ),
  transcribe: vi.fn<(id: string, uri: string) => Promise<string>>(),
  cancel: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    getParakeetUltraSize: () => 740_363_168,
    getParakeetUltraState: native.snapshot,
    addListener: native.listen,
    transcribeWithParakeetUltra: native.transcribe,
    cancelParakeetUltraTranscription: native.cancel,
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
import { parakeetUltraStateAtom, parakeetUltraTranscriber } from "../../native/parakeetUltra";
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

it("binds the hydrated engine until that recording ends, then honors an engine switch", async () => {
  const registry = AtomRegistry.make();
  mockRecorder();
  native.snapshot.mockResolvedValue({ revision: 1, state: { kind: "ready" } });
  native.transcribe.mockResolvedValue("Світ.");
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
    registry.set(preferences, AsyncResult.success({ deviceVoiceEngine: "parakeet-ultra" }));
    await start;
    expect(session.controller.currentState.phase).toBe("recording");
    registry.set(preferences, AsyncResult.success({ deviceVoiceEngine: "apple-speech" }));
    await session.controller.stop();
    expect(commit.mock.calls.map(([text]) => text)).toEqual(["Вітаю Світ."]);

    await session.start(target);
    await session.controller.stop();
    expect(commit.mock.calls.map(([text]) => text)).toEqual(["Вітаю Світ.", "Hello."]);
  } finally {
    session.controller.cancel();
    registry.dispose();
  }
});

it("keeps a selected engine unavailable after its model is removed", async () => {
  const registry = AtomRegistry.make();
  const initial = Promise.withResolvers<unknown>();
  native.snapshot.mockReturnValue(initial.promise);
  registry.set(preferences, AsyncResult.success({ deviceVoiceEngine: "parakeet-ultra" }));
  registry.set(localVoiceTranscriberAtom, {
    prepare: async () => ({ locale: "en-US", transcribe: async () => "Hello." }),
  });
  try {
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);
    const emit = native.listen.mock.lastCall?.[1];
    expect(emit).toBeDefined();
    emit?.({ revision: 2, state: { kind: "ready" } });
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
    initial.resolve({ revision: 1, state: { kind: "missing" } });
    await initial.promise;
    expect(registry.get(parakeetUltraStateAtom).kind).toBe("ready");

    emit?.({ revision: 3, state: { kind: "missing" } });
    expect(registry.get(voiceInputAvailableAtom)).toBe(false);
    registry.set(preferences, AsyncResult.success({ deviceVoiceEngine: "apple-speech" }));
    expect(registry.get(voiceInputAvailableAtom)).toBe(true);
  } finally {
    registry.dispose();
  }
});

it("discards a cancelled Parakeet transcript after the native operation settles", async () => {
  native.snapshot.mockResolvedValue({ revision: 1, state: { kind: "ready" } });
  const recording = Promise.withResolvers<string>();
  native.transcribe.mockReturnValue(recording.promise);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const prepared = await parakeetUltraTranscriber.prepare(options);
  const result = prepared.transcribe("file:///voice.m4a", options);
  const id = native.transcribe.mock.lastCall?.[0];
  controller.abort();
  expect(native.cancel).toHaveBeenCalledWith(id);
  recording.resolve("Late transcript.");
  await expect(result).rejects.toMatchObject({ code: "cancelled" });
});

import { DEFAULT_READ_ALOUD_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Speech from "expo-speech";
import { AppState, Platform } from "react-native";
import { createAudioPlayer, setAudioModeAsync, type AudioStatus } from "expo-audio";
import { acquireAudioSession, releaseAudioSession } from "../../lib/audioSession";
import { readAloudController } from "./playback";

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return "active";
    },
    addEventListener: () => ({ remove() {} }),
  },
  Platform: {
    get OS() {
      return "ios";
    },
  },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "speech-test" }));
vi.mock("expo-speech", () => ({
  getAvailableVoicesAsync: vi.fn(async () => []),
  speak: vi.fn(),
  resume: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: vi.fn() },
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: vi.fn(async () => {}),
  createAudioPlayer: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    uri = "test.mp3";
    exists = true;
    write() {}
    delete() {}
  },
}));
vi.mock("../../state/atom-registry", async () => {
  const Option = await import("effect/Option");
  return { appAtomRegistry: { get: () => Option.some({ environmentId: "host" }) } };
});
vi.mock("../../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => null },
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({ synthesizeSpeech: vi.fn() }));
vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: async () => Uint8Array.of(73, 68, 51, 1),
}));

it("falls back from a removed system voice and completes playback", async () => {
  vi.mocked(Speech.getAvailableVoicesAsync).mockResolvedValue([]);
  vi.mocked(Speech.speak).mockImplementation((_text, options) => options?.onDone?.());
  try {
    await readAloudController.start("system", "reply", {
      ...DEFAULT_READ_ALOUD_SETTINGS,
      provider: "system",
      voice: "removed-voice",
    });
    expect(Speech.speak).toHaveBeenLastCalledWith(
      "reply",
      expect.not.objectContaining({ voice: "removed-voice" }),
    );
    expect(readAloudController.getSnapshot().status).toBe("idle");
  } finally {
    readAloudController.stop();
  }
});

it("removes lock-screen playback when recording takes audio focus", async () => {
  const started = Promise.withResolvers<void>();
  const playing = Promise.withResolvers<void>();
  const unsubscribe = readAloudController.subscribe(() => {
    if (readAloudController.getSnapshot().status === "playing") playing.resolve();
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    readAloudController.stop();
    unsubscribe();
  });
  const player = {
    play: vi.fn(() => started.resolve()),
    pause: vi.fn(),
    release: vi.fn(),
    setPlaybackRate: vi.fn(),
    setActiveForLockScreen: vi.fn(),
    addListener:
      vi.fn<(_event: string, listener: (status: Partial<AudioStatus>) => void) => void>(),
  };
  vi.mocked(createAudioPlayer).mockReturnValue(
    player as unknown as ReturnType<typeof createAudioPlayer>,
  );
  const run = readAloudController.start("cloud", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "openrouter",
    speed: 1.25,
    environmentId: EnvironmentId.make("host"),
    backgroundPlayback: true,
  });
  await started.promise;
  await playing.promise;
  expect(player.setPlaybackRate).toHaveBeenCalledWith(1.25);
  const statusChanged = player.addListener.mock.calls[0]![1];
  statusChanged({
    currentTime: 1,
    duration: 10,
    playing: false,
    isLoaded: true,
    isBuffering: true,
    timeControlStatus: "waiting",
  });
  expect(readAloudController.getSnapshot().status).toBe("playing");
  statusChanged({
    currentTime: 10,
    duration: 10,
    playing: false,
    isLoaded: true,
    isBuffering: false,
    timeControlStatus: "paused",
  });
  expect(readAloudController.getSnapshot().status).toBe("playing");
  statusChanged({
    currentTime: 1,
    duration: 10,
    playing: false,
    isLoaded: true,
    isBuffering: false,
    timeControlStatus: "paused",
  });
  expect(readAloudController.getSnapshot().status).toBe("paused");
  expect(player.setActiveForLockScreen).toHaveBeenLastCalledWith(true, expect.anything());
  const pausedRecorder = acquireAudioSession("recording");
  try {
    expect(player.setActiveForLockScreen).toHaveBeenLastCalledWith(false);
  } finally {
    await releaseAudioSession(pausedRecorder);
  }
  await readAloudController.resume();
  statusChanged({
    currentTime: 1,
    duration: 10,
    playing: false,
    isLoaded: true,
    isBuffering: false,
    timeControlStatus: "paused",
  });
  const resumed = Promise.withResolvers<void>();
  const unsubscribeResume = readAloudController.subscribe(() => {
    if (readAloudController.getSnapshot().status === "playing") resumed.resolve();
  });
  cleanup.defer(unsubscribeResume);
  statusChanged({ playing: true, isLoaded: true });
  await resumed.promise;
  const recorder = acquireAudioSession("recording");
  try {
    expect(player.setActiveForLockScreen).toHaveBeenLastCalledWith(false);
  } finally {
    readAloudController.stop();
    await run;
    await releaseAudioSession(recorder);
    unsubscribe();
  }
});

it("cancels Android default speech while the native engine initializes", async () => {
  using _os = vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
  const loading = Promise.withResolvers<void>();
  const initialized = Promise.withResolvers<Speech.Voice[]>();
  vi.mocked(Speech.getAvailableVoicesAsync).mockClear();
  vi.mocked(Speech.getAvailableVoicesAsync).mockImplementationOnce(() => {
    loading.resolve();
    return initialized.promise;
  });
  vi.mocked(Speech.speak).mockClear();
  const run = readAloudController.start("android", "reply", {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "system",
    voice: "",
  });
  expect(Speech.getAvailableVoicesAsync).toHaveBeenCalled();
  await loading.promise;
  readAloudController.stop();
  initialized.resolve([]);
  await run;
  expect(Speech.speak).not.toHaveBeenCalled();
});

it.each(["system", "xai"] as const)(
  "keeps %s silent when backgrounded during activation",
  async (provider) => {
    using state = vi.spyOn(AppState, "currentState", "get").mockReturnValue("active");
    const activating = Promise.withResolvers<void>();
    const activated = Promise.withResolvers<void>();
    vi.mocked(setAudioModeAsync).mockImplementationOnce(async () => {
      activating.resolve();
      await activated.promise;
    });
    const play = vi.fn();
    vi.mocked(Speech.speak).mockClear();
    const player = {
      play,
      pause: vi.fn(),
      release: vi.fn(),
      addListener: vi.fn(),
      setActiveForLockScreen: vi.fn(),
    };
    vi.mocked(createAudioPlayer).mockReturnValue(
      player as unknown as ReturnType<typeof createAudioPlayer>,
    );
    const paused = Promise.withResolvers<void>();
    const unsubscribe = readAloudController.subscribe(() => {
      if (["paused", "playing"].includes(readAloudController.getSnapshot().status))
        paused.resolve();
    });
    const run = readAloudController.start("activation", "reply", {
      ...DEFAULT_READ_ALOUD_SETTINGS,
      provider,
      environmentId: EnvironmentId.make("host"),
      backgroundPlayback: false,
    });
    try {
      await activating.promise;
      state.mockReturnValue("background");
      activated.resolve();
      await paused.promise;
      expect(play).not.toHaveBeenCalled();
      expect(Speech.speak).not.toHaveBeenCalled();
    } finally {
      readAloudController.stop();
      await run;
      unsubscribe();
    }
  },
);

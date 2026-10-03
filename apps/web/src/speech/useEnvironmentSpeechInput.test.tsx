import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ClientSettings,
  type ServerSettings,
  type SpeechTranscriptionOptions,
  type EnvironmentId,
} from "@t3tools/contracts";

import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

const mocks = vi.hoisted(() => ({
  postProcessingEnabled: false,
  clientPreferences: {} as Partial<ClientSettings>,
  projectId: undefined as ProjectId | undefined,
  originSettings: null as ServerSettings | null,
  originPrepared: {} as PreparedConnection,
  recordingOptions: null as SpeechTranscriptionOptions | null,
  cleanup: vi.fn(),
  committed: vi.fn(),
  busy: false,
  microphoneFailure: true,
  missingModel: false,
  microphoneRequests: 0,
  ownerKey: "draft",
  prepared: {} as PreparedConnection,
  preparedEnvironmentId: null as EnvironmentId | null,
  preparedEnvironmentIds: [] as Array<EnvironmentId | null>,
  primaryEnvironmentId: "primary-environment" as EnvironmentId,
  transcriptionEnvironmentId: null as EnvironmentId | null,
}));
vi.mock("../state/session", () => ({
  usePreparedConnection: (environmentId: EnvironmentId | null) => {
    mocks.preparedEnvironmentId = environmentId;
    mocks.preparedEnvironmentIds.push(environmentId);
    return Option.some(
      environmentId === "project-environment" ? mocks.originPrepared : mocks.prepared,
    );
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
  useEnvironment: () =>
    mocks.originSettings ? { serverConfig: { settings: mocks.originSettings } } : null,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      voiceTranscriptionEnvironmentId: mocks.transcriptionEnvironmentId,
      speechPostProcessingEnabled: mocks.postProcessingEnabled,
      ...mocks.clientPreferences,
    };
    return selector ? selector(settings) : settings;
  },
  useEnvironmentSettings: () => mocks.postProcessingEnabled,
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({}) }));
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({
      supported: true,
      state: mocks.busy ? "transcribing" : mocks.missingModel ? "missing-model" : "ready",
      model: "test",
      modelId: "test-model",
      size: 731_357_568,
    }),
  postProcessEnvironmentTranscript: (...args: unknown[]) => {
    mocks.cleanup(...args);
    return Effect.succeed({ text: "Clean transcript" });
  },
  downloadEnvironmentSpeechModel: () =>
    Effect.sync(() => {
      mocks.missingModel = false;
    }),
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: (input: {
    getTranscriptionOptions: () => SpeechTranscriptionOptions;
  }) => ({
    recorder: {
      uri: "recording",
      prepareToRecordAsync: async () => {
        mocks.microphoneRequests += 1;
        if (mocks.microphoneFailure) throw new Error("no microphone");
      },
      record() {},
      stop: async () => {},
    },
    transcriber: {
      prepare: async () => {
        mocks.recordingOptions = input.getTranscriptionOptions();
        return { locale: "en", transcribe: async () => "Raw transcript" };
      },
    },
    cancelRecording() {},
    deleteRecording() {},
  }),
}));

let root: Root | undefined;
let voice: ReturnType<typeof useEnvironmentSpeechInput>;
function Probe() {
  const value = useEnvironmentSpeechInput({
    environmentId: "project-environment" as EnvironmentId,
    projectId: mocks.projectId,
    ownerKey: mocks.ownerKey,
    draftText: "",
    readDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
    commitDraft: mocks.committed,
  });
  useLayoutEffect(() => {
    voice = value;
  });
  return null;
}

async function mountProbe() {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: EventTarget,
    setTimeout: globalThis.setTimeout,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia() {} } });
  vi.stubGlobal("MediaRecorder", function MediaRecorder() {});
  root = createRoot(container as unknown as HTMLElement);
  await act(() => root!.render(<Probe />));
}

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  mocks.postProcessingEnabled = false;
  mocks.busy = false;
  mocks.microphoneFailure = true;
  mocks.missingModel = false;
  mocks.microphoneRequests = 0;
  mocks.ownerKey = "draft";
  mocks.transcriptionEnvironmentId = null;
  mocks.preparedEnvironmentId = null;
  mocks.preparedEnvironmentIds = [];
  mocks.clientPreferences = {};
  mocks.projectId = undefined;
  mocks.originSettings = null;
  mocks.recordingOptions = null;
  mocks.cleanup.mockClear();
  mocks.committed.mockClear();
  vi.unstubAllGlobals();
});
it("queues a recording while the environment is transcribing and starts when it drains", async () => {
  vi.useFakeTimers();
  try {
    mocks.microphoneFailure = false;
    mocks.busy = true;
    await mountProbe();
    let starting!: Promise<void>;
    await act(async () => {
      starting = voice.start();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(voice.state.phase).toBe("preparing");
    expect(mocks.microphoneRequests).toBe(0);
    mocks.busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await starting;
    });
    expect(voice.state.phase).toBe("recording");
    expect(mocks.microphoneRequests).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("starts a recording requested while a cancelled stream is finishing", async () => {
  vi.useFakeTimers();
  try {
    mocks.microphoneFailure = false;
    await mountProbe();
    await act(() => voice.start());
    expect(voice.state.phase).toBe("recording");
    await act(() => voice.cancel());
    mocks.busy = true;
    let starting!: Promise<void>;
    await act(async () => {
      starting = voice.start();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(voice.state.phase).toBe("preparing");
    expect(mocks.microphoneRequests).toBe(1);
    mocks.busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await starting;
    });
    expect(voice.state.phase).toBe("recording");
    expect(mocks.microphoneRequests).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
it("discards a queued recording when cancelled again", async () => {
  vi.useFakeTimers();
  try {
    mocks.microphoneFailure = false;
    await mountProbe();
    await act(() => voice.start());
    await act(() => voice.cancel());
    mocks.busy = true;
    let starting!: Promise<void>;
    await act(async () => {
      starting = voice.start();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(voice.state.phase).toBe("preparing");
    await act(() => voice.cancel());
    mocks.busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await starting;
    });
    expect(voice.state.phase).toBe("idle");
    expect(mocks.microphoneRequests).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("discards a queued recording when the draft owner changes", async () => {
  vi.useFakeTimers();
  try {
    mocks.microphoneFailure = false;
    await mountProbe();
    await act(() => voice.start());
    await act(() => voice.cancel());
    mocks.busy = true;
    let starting!: Promise<void>;
    await act(async () => {
      starting = voice.start();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    mocks.ownerKey = "another-draft";
    await act(() => root!.render(<Probe />));
    mocks.busy = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await starting;
    });
    expect(voice.state.phase).toBe("idle");
    expect(mocks.microphoneRequests).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
it("opens setup before requesting microphone access for a missing model", async () => {
  mocks.missingModel = true;
  await mountProbe();
  await act(() => voice.start());
  expect(voice.setup.open).toBe(true);
  expect(voice.setup.step).toBe(0);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => voice.setup.download());
  expect(voice.setup.step).toBe(1);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => voice.setup.startRecording());
  expect(mocks.microphoneRequests).toBe(1);
});
it("uses the primary environment for transcription by default", async () => {
  await mountProbe();
  expect(mocks.preparedEnvironmentIds).toContain(mocks.primaryEnvironmentId);

  mocks.transcriptionEnvironmentId = "voice-environment" as EnvironmentId;
  await act(() => root!.render(<Probe />));
  expect(mocks.preparedEnvironmentIds).toContain(mocks.transcriptionEnvironmentId);
});
it("clears the previous connection's recording error when replacing the controller", async () => {
  await mountProbe();
  await act(() => voice.start());
  expect(voice.state.phase).toBe("error");
  const previousConnection = mocks.prepared;
  mocks.prepared = {} as PreparedConnection;
  await act(() => root!.render(<Probe />));
  expect(voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
  mocks.prepared = previousConnection;
  await act(() => root!.render(<Probe />));
  expect(voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
});

it(" replacing post-processing settings does not strand recording state", async () => {
  mocks.microphoneFailure = false;
  await mountProbe();
  await act(() => voice.start());
  expect(voice.state.phase).toBe("recording");
  mocks.postProcessingEnabled = true;
  await act(() => root!.render(<Probe />));
  await act(() => voice.cancel());
  expect(voice.state.phase).toBe("idle");
  mocks.postProcessingEnabled = false;
});

it("transcribes on the selected host and cleans on the thread environment using one preference snapshot", async () => {
  mocks.microphoneFailure = false;
  mocks.postProcessingEnabled = true;
  mocks.transcriptionEnvironmentId = "voice-environment" as EnvironmentId;
  mocks.projectId = ProjectId.make("project-one");
  mocks.originSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [mocks.projectId]: { speechProjectCustomWords: [{ term: "Effect", aliases: ["a fact"] }] },
      [ProjectId.make("other-project")]: {
        speechProjectCustomWords: [{ term: "Unrelated", aliases: [] }],
      },
    },
  };
  mocks.clientPreferences = {
    speechLanguage: "fr",
    speechCorrectionWord: "pardon",
    speechCustomWords: [{ term: "T3 Code", aliases: [] }],
  };
  await mountProbe();
  await act(() => voice.start());
  expect(voice.state.phase).toBe("recording");
  expect(mocks.recordingOptions).toMatchObject({
    speechLanguage: "fr",
    speechCorrectionWord: "pardon",
    speechCustomWords: [
      { term: "Effect", aliases: ["a fact"] },
      { term: "T3 Code", aliases: [] },
    ],
  });
  mocks.clientPreferences = {
    speechLanguage: "en",
    speechCorrectionWord: "sorry",
    speechCustomWords: [],
  };
  mocks.postProcessingEnabled = false;
  await act(() => root!.render(<Probe />));
  expect(voice.state.phase).toBe("recording");
  await act(() => voice.stop());
  expect(mocks.cleanup).toHaveBeenCalledWith(
    mocks.originPrepared,
    "Raw transcript",
    { text: "", selection: { start: 0, end: 0 } },
    expect.objectContaining({
      speechCorrectionWord: "pardon",
      speechPostProcessingEnabled: true,
      speechCustomWords: mocks.recordingOptions!.speechCustomWords,
    }),
  );
  expect(mocks.committed).toHaveBeenCalledWith("Clean transcript", expect.anything());
  expect(mocks.preparedEnvironmentIds).toContain(mocks.transcriptionEnvironmentId);
  mocks.postProcessingEnabled = false;
});

it("preserves the original transcript without cleanup when the client disables it", async () => {
  mocks.microphoneFailure = false;
  mocks.postProcessingEnabled = false;
  await mountProbe();
  await act(() => voice.start());
  await act(() => voice.stop());
  expect(mocks.cleanup).not.toHaveBeenCalled();
  expect(mocks.committed).toHaveBeenCalledWith("Raw transcript", expect.anything());
});

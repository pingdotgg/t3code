import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { DEFAULT_CLIENT_SETTINGS, type EnvironmentId } from "@t3tools/contracts";

import { act, fakeTimers, render } from "../../test/render";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

const mocks = vi.hoisted(() => ({
  postProcessingEnabled: false,
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
    return Option.some(mocks.prepared);
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector({
      ...DEFAULT_CLIENT_SETTINGS,
      voiceTranscriptionEnvironmentId: mocks.transcriptionEnvironmentId,
    }),
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
  downloadEnvironmentSpeechModel: () =>
    Effect.sync(() => {
      mocks.missingModel = false;
    }),
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: () => ({
    recorder: {
      uri: null,
      prepareToRecordAsync: async () => {
        mocks.microphoneRequests += 1;
        if (mocks.microphoneFailure) throw new Error("no microphone");
      },
      record() {},
      stop: async () => {},
    },
    transcriber: { prepare: async () => ({ locale: "en", transcribe: async () => "" }) },
    releaseRecording() {},
    cancelRecording() {},
    deleteRecording() {},
  }),
}));

function Probe({
  ownerKey,
  onChange,
}: {
  ownerKey: string;
  onChange: (value: ReturnType<typeof useEnvironmentSpeechInput>) => void;
}) {
  const value = useEnvironmentSpeechInput({
    environmentId: "project-environment" as EnvironmentId,
    ownerKey,
    draftText: "",
    readDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
    commitDraft() {},
  });
  useLayoutEffect(() => {
    onChange(value);
  });
  return null;
}

function createProbe() {
  let voice!: ReturnType<typeof useEnvironmentSpeechInput>;
  const onChange = (value: ReturnType<typeof useEnvironmentSpeechInput>) => {
    voice = value;
  };
  return {
    get voice() {
      return voice;
    },
    view: () => <Probe ownerKey={mocks.ownerKey} onChange={onChange} />,
  };
}

function setup() {
  mocks.postProcessingEnabled = false;
  mocks.busy = false;
  mocks.microphoneFailure = true;
  mocks.missingModel = false;
  mocks.microphoneRequests = 0;
  mocks.ownerKey = "draft";
  mocks.transcriptionEnvironmentId = null;
  mocks.preparedEnvironmentId = null;
  mocks.preparedEnvironmentIds = [];
}

it("queues a recording while the environment is transcribing and starts when it drains", async () => {
  setup();
  using _timers = fakeTimers();
  mocks.microphoneFailure = false;
  mocks.busy = true;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  let starting!: Promise<void>;
  await act(async () => {
    starting = probe.voice.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(probe.voice.state.phase).toBe("preparing");
  expect(mocks.microphoneRequests).toBe(0);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(probe.voice.state.phase).toBe("recording");
  expect(mocks.microphoneRequests).toBe(1);
});
it("starts a recording requested while a cancelled stream is finishing", async () => {
  setup();
  using _timers = fakeTimers();
  mocks.microphoneFailure = false;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  expect(probe.voice.state.phase).toBe("recording");
  await act(() => probe.voice.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = probe.voice.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(probe.voice.state.phase).toBe("preparing");
  expect(mocks.microphoneRequests).toBe(1);
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(probe.voice.state.phase).toBe("recording");
  expect(mocks.microphoneRequests).toBe(2);
});
it("discards a queued recording when cancelled again", async () => {
  setup();
  using _timers = fakeTimers();
  mocks.microphoneFailure = false;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  await act(() => probe.voice.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = probe.voice.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(probe.voice.state.phase).toBe("preparing");
  await act(() => probe.voice.cancel());
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(probe.voice.state.phase).toBe("idle");
  expect(mocks.microphoneRequests).toBe(1);
});
it("discards a queued recording when the draft owner changes", async () => {
  setup();
  using _timers = fakeTimers();
  mocks.microphoneFailure = false;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  await act(() => probe.voice.cancel());
  mocks.busy = true;
  let starting!: Promise<void>;
  await act(async () => {
    starting = probe.voice.start();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  mocks.ownerKey = "another-draft";
  await _screen.rerender(probe.view());
  mocks.busy = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await starting;
  });
  expect(probe.voice.state.phase).toBe("idle");
  expect(mocks.microphoneRequests).toBe(1);
});
it("opens setup before requesting microphone access for a missing model", async () => {
  setup();
  mocks.missingModel = true;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  expect(probe.voice.setup.open).toBe(true);
  expect(probe.voice.setup.step).toBe(0);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => probe.voice.setup.download());
  expect(probe.voice.setup.step).toBe(1);
  expect(mocks.microphoneRequests).toBe(0);

  await act(() => probe.voice.setup.startRecording());
  expect(mocks.microphoneRequests).toBe(1);
});
it("uses the primary environment for transcription by default", async () => {
  setup();
  const probe = createProbe();
  await using _screen = await render(probe.view());
  expect(mocks.preparedEnvironmentIds).toContain(mocks.primaryEnvironmentId);

  mocks.transcriptionEnvironmentId = "voice-environment" as EnvironmentId;
  await _screen.rerender(probe.view());
  expect(mocks.preparedEnvironmentIds).toContain(mocks.transcriptionEnvironmentId);
});
it("clears the previous connection's recording error when replacing the controller", async () => {
  setup();
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  expect(probe.voice.state.phase).toBe("error");
  const previousConnection = mocks.prepared;
  mocks.prepared = {} as PreparedConnection;
  await _screen.rerender(probe.view());
  expect(probe.voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
  mocks.prepared = previousConnection;
  await _screen.rerender(probe.view());
  expect(probe.voice.state).toEqual({ phase: "idle", error: null, errorAction: null });
});

it(" replacing post-processing settings does not strand recording state", async () => {
  setup();
  mocks.microphoneFailure = false;
  const probe = createProbe();
  await using _screen = await render(probe.view());
  await act(() => probe.voice.start());
  expect(probe.voice.state.phase).toBe("recording");
  mocks.postProcessingEnabled = true;
  await _screen.rerender(probe.view());
  await act(() => probe.voice.cancel());
  expect(probe.voice.state.phase).toBe("idle");
  mocks.postProcessingEnabled = false;
});

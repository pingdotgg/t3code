import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { getEnvironmentSpeechModels } from "@t3tools/client-runtime/voice-input";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type EnvironmentSpeechModel,
  type ProjectId,
  type SpeechCustomWords,
  type SpeechPostProcessingOptions,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";

import { act, render, stubGlobal } from "../../test/render";
import { VoiceInputSetup } from "../components/chat/VoiceInputSetup";
import type { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  bindAudioGrant,
  pendingCloudAudioChoice,
} from "./voiceConsent";
import { writeBrowserClientSettings } from "../clientPersistenceStorage";

const mocks = vi.hoisted(() => ({
  voice: undefined as unknown as ReturnType<typeof useEnvironmentSpeechInput>,
  settings: {} as Record<string, unknown>,
  connected: new Set<string>(),
  voiceCapable: new Set<string>(),
  cloudVoiceCapable: new Set<string>(),
  canDictate: new Set<string>(),
  prepared: new Map<string, unknown>(),
  primaryEnvironmentId: "primary-env",
  statusRequests: [] as string[],
  statusUnavailable: false,
  modelState: "ready" as "ready" | "missing-model",
  statusModelId: "test-model",
  models: [] as EnvironmentSpeechModel[],
  catalogOffline: false,
  download: vi.fn<(modelId: string) => Promise<void>>(),
  selected: [] as string[],
  selectionFails: false,
  platforms: [] as string[],
  microphoneRequests: [] as string[],
  transcribeCalls: [] as string[],
  cleanupCalls: [] as string[],
  cleanupDraft: vi.fn(),
  cleanupOptions: [] as SpeechPostProcessingOptions[],
  recordingOptions: [] as SpeechTranscriptionOptions[],
  projectWords: {} as Record<string, SpeechCustomWords>,
  transcripts: [] as Array<string | Error | Promise<string>>,
  committed: vi.fn(),
  draft: "",
}));

vi.mock("../state/session", () => ({
  useEnvironmentScope: (id: string) => mocks.canDictate.has(id),
  usePreparedConnection: (environmentId: string | null) => {
    if (!environmentId || !mocks.connected.has(environmentId)) return Option.none();
    let prepared = mocks.prepared.get(environmentId);
    if (!prepared) {
      prepared = { environmentId, label: environmentId };
      mocks.prepared.set(environmentId, prepared);
    }
    return Option.some(prepared);
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
  useEnvironment: (environmentId: string | null) =>
    environmentId && mocks.connected.has(environmentId)
      ? {
          environmentId,
          serverConfig: {
            environment: {
              capabilities: {
                voiceTranscription: mocks.voiceCapable.has(environmentId),
                cloudVoiceTranscription: mocks.cloudVoiceCapable.has(environmentId),
              },
            },
          },
        }
      : null,
}));
vi.mock("../hooks/useSettings", () => ({
  updateClientSettings: vi.fn(),
  useClientSettingsHydrated: () => true,
  useClientSettings: (selector?: (settings: Record<string, unknown>) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, ...mocks.settings };
    return selector ? selector(settings) : settings;
  },
  useEnvironmentSettings: (
    environmentId: string,
    selector: (settings: Record<string, unknown>) => unknown,
  ) =>
    selector({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(environmentId === THREAD_ENV ? mocks.projectWords : {}).map(
          ([projectId, words]) => [projectId, { speechProjectCustomWords: words }],
        ),
      ),
    }),
}));
vi.mock("./runEnvironmentSpeech", () => ({ runEnvironmentSpeech: Effect.runPromise }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: (prepared: PreparedConnection) =>
    Effect.sync(() => {
      mocks.statusRequests.push(prepared.environmentId);
      if (mocks.statusUnavailable) throw new Error("Temporarily offline");
      return {
        supported: true,
        state: mocks.modelState,
        modelId: mocks.statusModelId,
        model: "Test",
        size: 1,
        supportsStreaming: false,
        supportsTranslation: false,
        acceleration: "auto",
        modelUnloadTimeout: "min_15",
        gpuDevices: [],
        benchmarkTier: "cpu",
      };
    }),
  downloadEnvironmentSpeechModel: (_prepared: PreparedConnection, modelId: string) =>
    Effect.promise(async () => {
      await mocks.download(modelId);
      return { models: mocks.models };
    }),
  selectEnvironmentSpeechModel: (_prepared: PreparedConnection, modelId: string) =>
    Effect.sync(() => {
      mocks.selected.push(modelId);
      if (mocks.selectionFails) throw new Error("selection failed");
      mocks.statusModelId = modelId;
      return { models: mocks.models };
    }),
  getEnvironmentSpeechModels: vi.fn(() =>
    Effect.sync(() => {
      if (mocks.catalogOffline) throw new Error("Catalog offline");
      return { models: mocks.models };
    }),
  ),
  postProcessEnvironmentTranscript: (
    prepared: PreparedConnection,
    transcript: string,
    draft: unknown,
    options: SpeechPostProcessingOptions,
  ) =>
    Effect.sync(() => {
      mocks.cleanupCalls.push(prepared.environmentId);
      mocks.cleanupDraft(draft);
      mocks.cleanupOptions.push(options);
      return { text: `Cleaned ${transcript}` };
    }),
}));
vi.mock("./browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: (
    input: Parameters<typeof createBrowserVoiceInputPlatform>[0],
  ) => {
    const environmentId = input.prepared.environmentId;
    mocks.platforms.push(environmentId);
    return {
      recorder: {
        uri: `blob:${environmentId}`,
        prepareToRecordAsync: async () => {
          mocks.microphoneRequests.push(environmentId);
        },
        record() {},
        stop: async () => {},
      },
      transcriber: {
        prepare: async () => {
          mocks.recordingOptions.push(input.getTranscriptionOptions());
          return {
            locale: "en",
            transcribe: async () => {
              mocks.transcribeCalls.push(
                input.cloudProvider
                  ? `${[input.cloudProvider, (input as { cloudModel?: string }).cloudModel].filter(Boolean).join(":")} via ${environmentId}`
                  : environmentId,
              );
              const next = mocks.transcripts.shift() ?? "dictated";
              if (next instanceof Error) throw next;
              return next;
            },
          };
        },
      },
      cancelRecording() {},
      deleteRecording() {},
    };
  },
}));

const THREAD_ENV = "thread-env";

function setup(options: { readonly destination?: string | null } = {}) {
  mocks.settings = {};
  setDestination(options.destination ?? null);
  if (!options.destination) localStorage.removeItem("t3code:voice-audio-grant:v1");
  chooseTranscriptCleanup(false);
  mocks.primaryEnvironmentId = "primary-env";
  mocks.connected = new Set(["primary-env", THREAD_ENV, "env-a", "env-b"]);
  mocks.voiceCapable = new Set(["primary-env", THREAD_ENV, "env-a", "env-b"]);
  mocks.cloudVoiceCapable.clear();
  mocks.canDictate = new Set(mocks.voiceCapable);
  mocks.prepared.clear();
  mocks.statusRequests = [];
  mocks.statusUnavailable = false;
  mocks.modelState = "ready";
  mocks.statusModelId = "test-model";
  mocks.models = [];
  mocks.catalogOffline = false;
  mocks.download.mockReset();
  mocks.selected = [];
  mocks.selectionFails = false;
  mocks.platforms = [];
  mocks.microphoneRequests = [];
  mocks.transcribeCalls = [];
  mocks.cleanupCalls = [];
  mocks.cleanupDraft.mockClear();
  mocks.cleanupOptions = [];
  mocks.recordingOptions = [];
  mocks.projectWords = {};
  mocks.transcripts = [];
  mocks.committed.mockClear();
  mocks.draft = "";
}

function setDestination(environmentId: string | null) {
  chooseAudioDestination(
    environmentId ? { kind: "environment", environmentId: environmentId as EnvironmentId } : null,
  );
}

function Probe(props: {
  readonly ownerKey?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly cleanup?: boolean;
  readonly showWizard?: boolean;
}) {
  const value = useEnvironmentSpeechInput({
    environmentId: THREAD_ENV as EnvironmentId,
    projectId: props.projectId as ProjectId | undefined,
    projectName: props.projectName,
    cleanup: props.cleanup,
    ownerKey: props.ownerKey ?? "draft",
    draftText: mocks.draft,
    readDraft: () => ({
      text: mocks.draft,
      selection: { start: mocks.draft.length, end: mocks.draft.length },
    }),
    commitDraft: mocks.committed,
  });
  useLayoutEffect(() => {
    mocks.voice = value;
  });
  return props.showWizard ? (
    <VoiceInputSetup
      {...value.setup}
      environmentId={value.transcriptionEnvironmentId}
      status={value.status}
      onOpenChange={value.setup.setOpen}
      onRetryCatalog={value.setup.retryCatalog}
      onDownload={value.setup.download}
      onCancelDownload={value.setup.cancelDownload}
      onStartRecording={value.setup.startRecording}
    />
  ) : null;
}

function expectNoAudioSent() {
  expect(mocks.platforms).toEqual([]);
  expect(mocks.microphoneRequests).toEqual([]);
  expect(mocks.transcribeCalls).toEqual([]);
  expect(mocks.statusRequests).toEqual([]);
}

it.each([
  ["nothing is configured", {}],
  // A transcription host picked by an earlier PoC build is not consent.
  ["a legacy transcription host is configured", { voiceTranscriptionEnvironmentId: "env-a" }],
])("opens destination setup without sending audio when %s", async (_, legacy) => {
  setup();
  mocks.settings = { ...legacy, speechSilenceFiltering: true };
  await using screen = await render(<Probe />);
  // The composer mic and the dictation shortcut both gate on this.
  expect(mocks.voice.available).toBe(true);
  await act(() => mocks.voice.start());
  expect(screen.router?.state.location).toMatchObject({
    pathname: "/settings/voice",
    hash: "voice-transcription-destination",
  });
  expectNoAudioSent();
  expect(mocks.committed).not.toHaveBeenCalled();
  expect(mocks.voice.state.phase).toBe("idle");
  expect(mocks.voice.transcriptionEnvironmentId).toBeNull();
  expect(localStorage.getItem("t3code:voice-audio-grant:v1")).toBeNull();
});

it.each([true, false])(
  "sends audio with silence filtering %s only to the chosen environment",
  async (speechSilenceFiltering) => {
    setup({ destination: "env-a" });
    mocks.settings = { speechSilenceFiltering };
    await using _screen = await render(<Probe />);
    expect(mocks.voice.transcriptionEnvironmentId).toBe("env-a");
    await act(() => mocks.voice.start());
    expect(mocks.voice.state.phase).toBe("recording");
    await act(() => mocks.voice.stop());
    expect(
      new Set([...mocks.platforms, ...mocks.microphoneRequests, ...mocks.transcribeCalls]),
    ).toEqual(new Set(["env-a"]));
    expect(mocks.statusRequests.every((id) => id === "env-a")).toBe(true);
    expect(mocks.recordingOptions[0]?.speechSilenceFiltering).toBe(speechSilenceFiltering);
    // Cleanup is a separate opt-in and stays off by default.
    expect(mocks.cleanupCalls).toEqual([]);
    expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("dictated", expect.anything());
  },
);

it.each([
  ["is disconnected", () => mocks.connected.delete("env-a")],
  ["cannot operate", () => mocks.canDictate.delete("env-a")],
  ["does not support transcription", () => mocks.voiceCapable.delete("env-a")],
])(
  "does not fall back to another environment when the chosen one %s",
  async (_, breakDestination) => {
    setup({ destination: "env-a" });
    breakDestination();
    await using _screen = await render(<Probe />);
    await act(() => mocks.voice.start());
    expectNoAudioSent();
    expect(mocks.voice.available).toBe(false);
  },
);

it.each([
  ["revoked", null],
  ["moved to another environment", "env-b"],
  ["renewed for the same environment", "env-a"],
])("abandons an in-progress recording when consent is %s", async (_, next) => {
  setup({ destination: "env-a" });
  await using screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  expect(mocks.voice.state.phase).toBe("recording");
  setDestination(next);
  await screen.rerender(<Probe />);
  if (next === null) expect(mocks.voice.available).toBe(false);
  expect(mocks.voice.state.phase).toBe("idle");
  await act(() => mocks.voice.stop());
  expect(mocks.transcribeCalls).toEqual([]);
  expect(mocks.committed).not.toHaveBeenCalled();
});

it("retries a failed transcription on the same chosen environment", async () => {
  setup({ destination: "env-a" });
  mocks.transcripts = [new Error("inference failed"), "second try"];
  await using _screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.voice.state).toMatchObject({ phase: "error", errorAction: "retry" });
  await act(() => mocks.voice.start());
  if (mocks.voice.state.phase === "recording") await act(() => mocks.voice.stop());
  expect(mocks.transcribeCalls).toEqual(["env-a", "env-a"]);
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("second try", expect.anything());
});

function confirmedSend(text: string) {
  const draft = { text, submit: vi.fn(), cancel: vi.fn() };
  let resolveTranscript!: (value: string) => void;
  mocks.transcripts.push(new Promise<string>((resolve) => (resolveTranscript = resolve)));
  const confirm = () =>
    mocks.voice.submitAfterDictation(draft.submit, {
      draft: {
        unchanged: () => draft.text === text,
        commit: (next) => {
          draft.text = next;
        },
      },
      cancel: draft.cancel,
    });
  return { draft, confirm, land: (value: string) => resolveTranscript(value) };
}

it.each([
  ["another thread is shown", () => <Probe ownerKey="thread-b" />],
  ["its editor unmounts", () => <span />],
])("finishes a confirmed send on its own draft after %s", async (_, away) => {
  setup({ destination: "env-a" });
  mocks.draft = "a-draft";
  const a = confirmedSend("a-draft");
  await using screen = await render(<Probe ownerKey="thread-a" />);
  await act(() => mocks.voice.start());
  await act(() => a.confirm());
  expect(mocks.voice.state.phase).toBe("transcribing");
  mocks.draft = "b-draft";
  await screen.rerender(away());
  await act(async () => a.land("from A"));
  await vi.waitFor(() => expect(a.draft.submit).toHaveBeenCalledExactlyOnceWith("a-draft from A"));
  expect(a.draft.text).toBe("a-draft from A");
  expect(a.draft.cancel).not.toHaveBeenCalled();
  expect(mocks.committed).not.toHaveBeenCalled();
});

it("keeps another thread's dictation out of a pending confirmed send", async () => {
  setup({ destination: "env-a" });
  mocks.draft = "a-draft";
  const a = confirmedSend("a-draft");
  await using screen = await render(<Probe ownerKey="thread-a" />);
  await act(() => mocks.voice.start());
  await act(() => a.confirm());
  mocks.draft = "b-draft";
  await screen.rerender(<Probe ownerKey="thread-b" />);
  expect(mocks.voice.state.phase).toBe("idle");
  await act(() => mocks.voice.start());
  expect(mocks.voice.state.phase).toBe("idle");
  const submitB = vi.fn();
  await act(() => mocks.voice.submitAfterDictation(submitB));
  expect(submitB).toHaveBeenCalledExactlyOnceWith("b-draft");
  await act(async () => a.land("from A"));
  await vi.waitFor(() => expect(a.draft.submit).toHaveBeenCalledExactlyOnceWith("a-draft from A"));
  expect(mocks.committed).not.toHaveBeenCalled();
  mocks.transcripts = ["from B"];
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("b-draft from B", expect.anything());
  expect(a.draft.submit).toHaveBeenCalledOnce();
});

it("drops a confirmed send whose draft changed before its transcript landed", async () => {
  setup({ destination: "env-a" });
  mocks.draft = "a-draft";
  const a = confirmedSend("a-draft");
  await using screen = await render(<Probe ownerKey="thread-a" />);
  await act(() => mocks.voice.start());
  await act(() => a.confirm());
  await screen.rerender(<Probe ownerKey="thread-b" />);
  a.draft.text = "edited elsewhere";
  await act(async () => a.land("from A"));
  await vi.waitFor(() => expect(a.draft.cancel).toHaveBeenCalledOnce());
  expect(a.draft.submit).not.toHaveBeenCalled();
  expect(a.draft.text).toBe("edited elsewhere");
});

it("reopens setup after reconnecting during a download and ignores its stale completion", async () => {
  setup({ destination: "env-a" });
  mocks.modelState = "missing-model";
  mocks.settings = { speechLanguage: "en" };
  mocks.models = [catalogModel(mocks.statusModelId, ["en"], true)];
  let finishDownload!: () => void;
  mocks.download.mockReturnValue(
    new Promise<void>((resolve) => {
      finishDownload = resolve;
    }),
  );
  await using screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  let done: Promise<void> | undefined;
  await act(() => {
    done = mocks.voice.setup.download();
  });
  expect(mocks.voice.setup.downloading).toBe(true);
  mocks.connected.delete("env-a");
  await screen.rerender(<Probe />);
  expect(mocks.voice.setup.open).toBe(false);
  mocks.connected.add("env-a");
  await screen.rerender(<Probe />);
  await act(() => mocks.voice.start());
  expect(mocks.voice.setup).toMatchObject({ open: true, downloading: false, step: 0 });
  finishDownload();
  await act(async () => {
    await done;
  });
  expect(mocks.voice.setup.error).toBeNull();
});

function catalogModel(
  id: string,
  languages: readonly string[],
  recommended: boolean,
): EnvironmentSpeechModel {
  return {
    id,
    name: id,
    description: "",
    size: 1,
    languages,
    accuracy: 0,
    speed: 0,
    recommended,
    supportsStreaming: false,
    supportsLanguageDetection: languages.length > 1,
    supportsTranslation: false,
    active: false,
    state: "downloadable",
  };
}

it.each([
  ["the browser prefers German", ["de-DE"], undefined, "auto"],
  ["the desktop exposes no locale methods", ["de-DE"], {}, "auto"],
  [
    "an older preload exposes only the OS locale",
    ["en-US"],
    { getSystemLocale: () => "de-DE" },
    "auto",
  ],
  [
    "the desktop OS prefers German",
    ["en-US"],
    { getPreferredSystemLanguages: () => ["de-DE"] },
    "auto",
  ],
  ["German is the chosen Voice language", ["en-US"], undefined, "de"],
])(
  "offers and downloads a German-capable model when %s",
  async (_, languages, bridge, speechLanguage) => {
    setup({ destination: "env-a" });
    mocks.settings = { speechLanguage };
    using _languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
    using _bridge = stubGlobal("desktopBridge", bridge);
    const englishDefault = "handy-computer/parakeet-unified-en-0.6b-gguf";
    const german = "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf";
    mocks.modelState = "missing-model";
    mocks.statusModelId = englishDefault;
    mocks.models = [
      { ...catalogModel(englishDefault, ["en"], true), active: true },
      catalogModel(german, ["en", "de", "fr"], true),
      catalogModel("handy-computer/canary-180m-flash-gguf", ["en", "de", "es", "fr"], true),
    ];
    mocks.download.mockResolvedValue(undefined);
    await using _screen = await render(<Probe />);
    await act(() => mocks.voice.start());
    expect(mocks.voice.setup.open).toBe(true);
    await act(() => mocks.voice.setup.download());
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith(german);
    expect(mocks.voice.setup.model?.id).toBe(german);
  },
);

it.each(["cancel", "failed restart"] as const)(
  "closes pending catalog setup on %s",
  async (action) => {
    setup({ destination: "env-a" });
    mocks.modelState = "missing-model";
    mocks.settings = { speechLanguage: "en" };
    mocks.models = [catalogModel("current", ["en"], true)];
    const response = Deferred.makeUnsafe<{ models: EnvironmentSpeechModel[] }>();
    vi.mocked(getEnvironmentSpeechModels).mockReturnValueOnce(Deferred.await(response));
    await using _screen = await render(<Probe showWizard />);
    let firstStart!: Promise<void>;
    await act(() => {
      firstStart = mocks.voice.start();
    });
    await expect.element(page.getByText("Loading transcription models…")).toBeVisible();
    if (action === "cancel") {
      await act(() => mocks.voice.cancel());
    } else {
      mocks.statusUnavailable = true;
      await act(() => mocks.voice.start());
      mocks.statusUnavailable = false;
    }
    expect(mocks.voice.setup.open).toBe(false);

    await act(() => mocks.voice.start());
    Deferred.doneUnsafe(
      response,
      Effect.succeed({ models: [catalogModel("stale", ["en"], true)] }),
    );
    await act(() => firstStart);
    await expect.element(page.getByRole("heading", { name: "current" })).toBeVisible();
    expect(mocks.microphoneRequests).toEqual([]);
  },
);

it.each([true, false])(
  "never downloads the English default when no German recommendation is available (catalog offline: %s)",
  async (offline) => {
    setup({ destination: "env-a" });
    mocks.settings = { speechLanguage: "de" };
    mocks.modelState = "missing-model";
    mocks.statusModelId = "english";
    mocks.models = [catalogModel("english", ["en"], true)];
    mocks.catalogOffline = offline;
    await using _screen = await render(<Probe showWizard />);
    await act(() => mocks.voice.start());
    const wizard = page.getByRole("dialog", { name: "Set up voice input" });
    const retry = wizard.getByRole("button", { name: "Retry loading models" });
    const download = wizard.getByRole("button", { name: "Download model" });
    await expect.element(wizard.getByRole("alert")).toBeVisible();
    await expect.element(download).not.toBeInTheDocument();
    if (offline) {
      mocks.catalogOffline = false;
      mocks.models.push(catalogModel("german", ["de"], true));
      // Another client can finish setup while the catalog is offline.
      mocks.modelState = "ready";
      await userEvent.click(retry);
      await expect.element(wizard.getByRole("heading", { name: "german" })).toBeVisible();
      await expect.element(download).toBeEnabled();
    }
    await expect.element(retry).not.toBeInTheDocument();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.microphoneRequests).toEqual([]);
  },
);

it.each([
  ["selects the offered model once its download installed it", "installed", ["german"], null],
  [
    "does not advance a cancelled download when another model is ready",
    "downloadable",
    [],
    "The model is not ready. Try downloading it again.",
  ],
  [
    "reports a failed selection apart from the download",
    "installed",
    ["german"],
    "The model downloaded, but this environment could not select it. Try again.",
  ],
] as const)("%s", async (_, landedState, selected, error) => {
  setup({ destination: "env-a" });
  using _languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
  mocks.selectionFails = error !== null && landedState === "installed";
  mocks.modelState = "missing-model";
  mocks.statusModelId = "english";
  mocks.models = [catalogModel("english", ["en"], true), catalogModel("german", ["de"], true)];
  mocks.download.mockImplementation(async () => {
    mocks.models = [mocks.models[0]!, { ...mocks.models[1]!, state: landedState }];
    mocks.modelState = "ready";
  });
  await using _screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  expect(mocks.voice.setup.language).toBe("de");
  await act(() => mocks.voice.setup.download());
  expect(mocks.selected).toEqual(selected);
  expect(mocks.voice.setup.error).toBe(error);
  expect(mocks.voice.setup.downloading).toBe(false);
  expect(mocks.voice.setup.step).toBe(landedState === "installed" && !error ? 1 : 0);
});

it("does not resend a failed recording after consent is revoked", async () => {
  setup({ destination: "env-a" });
  mocks.transcripts = [new Error("inference failed")];
  await using screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.voice.state.phase).toBe("error");
  setDestination(null);
  await screen.rerender(<Probe />);
  await act(() => mocks.voice.start());
  expect(mocks.transcribeCalls).toEqual(["env-a"]);
  expect(mocks.microphoneRequests).toEqual(["env-a"]);
  expect(mocks.committed).not.toHaveBeenCalled();
});

it("revokes across windows even before the storage event and survives stale preference writes", async () => {
  setup({ destination: "env-a" });
  await using _screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  expect(mocks.voice.state.phase).toBe("recording");
  const other = document.createElement("iframe");
  document.body.append(other);
  try {
    const storage = other.contentWindow!.localStorage;
    const key = "t3code:voice-audio-grant:v1";
    const grant = JSON.parse(storage.getItem(key)!) as { id: string };
    const canSend = bindAudioGrant(grant.id);
    expect(canSend()).toBe(true);
    const saved = pendingCloudAudioChoice({
      kind: "cloud",
      provider: "openai",
      environmentId: EnvironmentId.make("env-a"),
    });
    expect(canSend()).toBe(true);
    storage.removeItem(key);
    saved();
    expect(storage.getItem(key)).toBeNull();
    expect(canSend()).toBe(false);
    writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, wordWrap: false });
    await vi.waitFor(() => expect(mocks.voice.transcriptionEnvironmentId).toBeNull());
    expect(mocks.voice.state.phase).toBe("idle");
    await act(() => mocks.voice.stop());
    expect(mocks.transcribeCalls).toEqual([]);
    setDestination("env-a");
    expect(canSend()).toBe(false);
  } finally {
    other.remove();
  }
});

it.each(["not-json", JSON.stringify("off")])(
  "does not enable a pending provider over %s before the save completes",
  async (previous) => {
    setup();
    mocks.cloudVoiceCapable.add("env-b");
    mocks.modelState = "missing-model";
    window.localStorage.setItem("t3code:voice-audio-grant:v1", previous);
    const save = pendingCloudAudioChoice({
      kind: "cloud",
      environmentId: EnvironmentId.make("env-b"),
      provider: "xai",
    });
    await using _screen = await render(<Probe />);
    expect(mocks.voice.transcriptionEnvironmentId).toBeNull();
    if (previous === JSON.stringify("off")) expect(mocks.voice.available).toBe(false);
    await act(() => mocks.voice.start());
    expectNoAudioSent();
    await act(save);
    await act(() => mocks.voice.start());
    await act(() => mocks.voice.stop());
    expect(mocks.transcribeCalls).toEqual(["xai via env-b"]);
    expect(mocks.statusRequests).toEqual([]);
  },
);

it("sends audio to OpenRouter only under a device grant naming the exact model", async () => {
  setup();
  mocks.cloudVoiceCapable.add("env-b");
  const key = "t3code:voice-audio-grant:v1";
  const destination = { kind: "cloud", environmentId: "env-b", provider: "openrouter" };
  window.localStorage.setItem(key, JSON.stringify({ id: "no-model", destination }));
  {
    await using _screen = await render(<Probe />);
    await act(() => mocks.voice.start());
    expectNoAudioSent();
  }
  const model = "acme/transcribe-1";
  window.localStorage.setItem(
    key,
    JSON.stringify({ id: "model", destination: { ...destination, model } }),
  );
  await using _screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.transcribeCalls).toEqual([`openrouter:${model} via env-b`]);
  expect(mocks.statusRequests).toEqual([]);
});

it("uses neither destination when the cloud save marker cannot be read", async () => {
  setup({ destination: "env-a" });
  const key = "t3code:voice-audio-grant:v1";
  const previous = JSON.parse(window.localStorage.getItem(key)!) as { id: string };
  const canSendToPrevious = bindAudioGrant(previous.id);
  const save = pendingCloudAudioChoice({
    kind: "cloud",
    environmentId: EnvironmentId.make("env-b"),
    provider: "openai",
  });
  save();
  const getItem = Storage.prototype.getItem;
  using _blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
    this: Storage,
    k,
  ) {
    if (k.startsWith(`${key}:saved:`))
      throw new DOMException("Storage is blocked", "SecurityError");
    return getItem.call(this, k);
  });
  await using _screen = await render(<Probe />);
  expect(mocks.voice.transcriptionEnvironmentId).toBeNull();
  expect(canSendToPrevious()).toBe(false);
  expect(mocks.voice.available).toBe(false);
  await act(() => mocks.voice.start());
  expectNoAudioSent();
});

it("cleans text on a cloud-only draft environment only while cleanup is separately enabled", async () => {
  setup({ destination: "env-a" });
  mocks.voiceCapable.delete(THREAD_ENV);
  mocks.cloudVoiceCapable.add(THREAD_ENV);
  chooseTranscriptCleanup(true);
  const nearby = "x".repeat(1_024);
  mocks.draft = "unrelated private paragraph " + nearby;
  await using screen = await render(<Probe />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.transcribeCalls).toEqual(["env-a"]);
  expect(mocks.cleanupCalls).toEqual([THREAD_ENV]);
  expect(mocks.cleanupDraft).toHaveBeenCalledExactlyOnceWith({
    text: nearby,
    selection: { start: nearby.length, end: nearby.length },
  });
  expect(mocks.committed).toHaveBeenCalledExactlyOnceWith(
    mocks.draft + " Cleaned dictated",
    expect.anything(),
  );

  await act(() => mocks.voice.start());
  chooseTranscriptCleanup(false);
  await screen.rerender(<Probe />);
  await act(() => mocks.voice.stop());
  expect(mocks.cleanupCalls).toHaveLength(1);
});

// The settings model test must show what the model heard, not what a provider rewrote.
it.each([
  { cleanup: false, authorized: true },
  { cleanup: undefined, authorized: false },
])(
  "keeps a recording without authorized cleanup off the provider: $cleanup / $authorized",
  async ({ cleanup, authorized }) => {
    setup({ destination: "env-a" });
    mocks.cloudVoiceCapable.add(THREAD_ENV);
    chooseTranscriptCleanup(true);
    mocks.settings.speechCorrectionWord = "sorry";
    if (!authorized) mocks.canDictate.delete(THREAD_ENV);
    mocks.projectWords = { "proj-1": [{ term: "Acme", aliases: ["ack me"] }] };
    await using _screen = await render(
      <Probe {...(cleanup === undefined ? {} : { cleanup })} projectId="proj-1" />,
    );
    await act(() => mocks.voice.start());
    await act(() => mocks.voice.stop());
    expect(mocks.cleanupCalls).toEqual([]);
    expect(mocks.recordingOptions.at(-1)?.speechCustomWords).toEqual(mocks.projectWords["proj-1"]);
    expect(mocks.recordingOptions.at(-1)?.speechCorrectionWord).toBeUndefined();
    expect(mocks.transcribeCalls).toEqual(["env-a"]);
    expect(mocks.committed).toHaveBeenCalledExactlyOnceWith("dictated", expect.anything());
  },
);

it("sends the project's vocabulary and name as hints, and the cue only with cleanup on", async () => {
  setup({ destination: "env-a" });
  mocks.settings.speechCustomWords = [{ term: "Effect", aliases: ["a fact"] }];
  mocks.settings.speechCorrectionWord = "scratch that";
  // Stored on the draft's environment under its project, never read from the audio destination.
  mocks.projectWords = { "proj-1": [{ term: "effect", aliases: ["affect"] }] };
  await using screen = await render(<Probe projectId="proj-1" projectName="Acme App" />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.recordingOptions.at(-1)?.speechCustomWords).toEqual([
    { term: "Acme App", aliases: [] },
    { term: "effect", aliases: ["affect"] },
  ]);
  expect(mocks.cleanupCalls).toEqual([]);

  chooseTranscriptCleanup(true);
  await screen.rerender(<Probe projectId="proj-1" projectName="Acme App" />);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.recordingOptions.at(-1)?.speechCustomWords.map(({ term }) => term)).toEqual([
    "scratch that",
    "Acme App",
    "effect",
  ]);
  expect(mocks.cleanupOptions.at(-1)).toMatchObject({ speechCorrectionWord: "scratch that" });
  expect(mocks.recordingOptions.at(-1)?.speechCorrectionWord).toBe("scratch that");
  chooseTranscriptCleanup(false);
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.recordingOptions.at(-1)?.speechCorrectionWord).toBeUndefined();
  expect(mocks.recordingOptions.at(-1)?.speechCustomWords.map(({ term }) => term)).not.toContain(
    "scratch that",
  );
});

it("shares one status probe per destination across every mounted editor", async () => {
  setup({ destination: "env-a" });
  await using _screen = await render(
    <>
      <Probe />
      <Probe />
      <Probe />
    </>,
  );
  expect(mocks.voice.available).toBe(true);
  expect(mocks.statusRequests).toEqual(["env-a"]);
});

it("lets the user retry after a status failure without reselecting the destination", async () => {
  setup({ destination: "env-a" });
  mocks.statusUnavailable = true;
  await using _screen = await render(<Probe />);
  expect(mocks.statusRequests).toEqual(["env-a"]);
  expect(mocks.voice.available).toBe(true);
  expect(mocks.microphoneRequests).toEqual([]);
  mocks.statusUnavailable = false;
  await act(() => mocks.voice.start());
  await act(() => mocks.voice.stop());
  expect(mocks.transcribeCalls).toEqual(["env-a"]);
});

import { createElement, type ReactNode } from "react";
import { act, render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  rerender: async () => {},
  voiceCapability: true as boolean | undefined,
  statusRequests: vi.fn(),
  toast: vi.fn(),
  cancel: vi.fn(),
  listModels: vi.fn(),
  saveWords: vi.fn(),
  saveClient: vi.fn(),
  saveTranslation: vi.fn(),
  speechStatus: {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  },
  scope: null as null | {
    target: { projectId: string } | null;
    scope: { label: string; kind: string; members: { id: string }[] };
    search: { project: string };
    selectScope: ReturnType<typeof vi.fn>;
  },
  projectWords: [] as { term: string; aliases: string[] }[],
  customWords: [] as { term: string; aliases: string[] }[],
  connection: {},
  settings: {
    voiceTranscriptionEnvironmentId: null as string | null,
    voiceMicrophone: "",
    speechLanguage: "auto",
  },
}));
vi.mock("@t3tools/client-runtime/voice-input", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () => {
    mocks.statusRequests();
    return Promise.resolve({
      supported: true,
      acceleration: "auto",
      modelUnloadTimeout: "min_15",
      language: "auto",
      ...mocks.speechStatus,
      gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
      customWords: mocks.customWords,
      projectCustomWords: mocks.projectWords,
    });
  },
  updateEnvironmentSpeechFillerWordRemoval: () => Promise.resolve({ supported: true }),
  updateEnvironmentSpeechCustomWords: mocks.saveWords,
  updateEnvironmentSpeechTranslation: mocks.saveTranslation,
  getEnvironmentSpeechModels: () =>
    mocks.listModels() ??
    Promise.resolve({
      models: [
        {
          id: "model",
          name: "Model",
          languages: ["en"],
          supportsLanguageDetection: false,
          supportsTranslation: false,
          state: "downloading",
          size: 100,
        },
      ],
    }),
  cancelEnvironmentSpeechModelDownload: mocks.cancel,
}));
vi.mock("./SettingsScopeContext", async () => ({
  useOptionalSettingsScope: () => mocks.scope,
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    useClientSettings: (select?: (settings: unknown) => unknown) => {
      const settings = {
        ...DEFAULT_CLIENT_SETTINGS,
        ...mocks.settings,
        speechCustomWords: mocks.customWords,
      };
      return select ? select(settings) : settings;
    },
    useClientSettingsHydrated: () => true,
    updateClientSettings: async (patch: Record<string, unknown>) => {
      mocks.saveClient(patch);
      if (patch.speechCustomWords)
        mocks.customWords = patch.speechCustomWords as typeof mocks.customWords;
      Object.assign(mocks.settings, patch);
      await mocks.rerender();
    },
  };
});
vi.mock("./useScopedSettings", async () => ({
  useScopedSettings: () => ({ speechProjectCustomWords: mocks.projectWords }),
  useUpdateScopedSettings:
    () => async (patch: { speechProjectCustomWords: typeof mocks.projectWords }) => {
      mocks.saveWords(patch);
      mocks.projectWords = patch.speechProjectCustomWords;
      await mocks.rerender();
    },
}));
vi.mock("../../lib/runtime", async () => ({
  runtime: { runPromise: (value: unknown) => value },
}));
vi.mock("../../state/environments", async () => ({
  usePrimaryEnvironmentId: () => "environment",
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment",
        label: "My Computer",
        serverConfig: {
          environment: { capabilities: { voiceTranscription: mocks.voiceCapability } },
        },
      },
    ],
  }),
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    usePreparedConnection: () => Option.some(mocks.connection),
  };
});
vi.mock("../../localApi", async () => ({
  ensureLocalApi: vi.fn(),
}));
vi.mock("../ui/toast", async () => ({
  toastManager: { add: mocks.toast },
}));
vi.mock("./settingsSearch", async () => ({
  searchableSetting: () => ({}),
}));
vi.mock("./VoicePostProcessingSettings", async () => ({
  VoicePostProcessingSettings: () => null,
}));
vi.mock("./TranscriptionTest", async () => ({
  TranscriptionTest: ({ modelName }: { modelName: string }) =>
    createElement("span", null, modelName),
}));
vi.mock("./MicrophoneTest", async () => ({
  MicrophoneTest: ({ microphoneControl }: { microphoneControl: ReactNode }) => microphoneControl,
}));
vi.mock("./settingsLayout", async () => ({
  SettingsPageContainer: "div",
  SettingsSection: "section",
  SettingsRow: ({
    control,
    description,
    children,
  }: {
    control: ReactNode;
    description?: string;
    children?: ReactNode;
  }) => createElement("div", null, createElement("p", null, description), control, children),
}));
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => {
  const selector = `[aria-label="${label}"]`;
  const element =
    document.querySelector<T>(`button${selector}`) ?? document.querySelector<T>(selector);
  expect(element, label).not.toBeNull();
  return element!;
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label)!;
const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll("p")].map((entry) => entry.textContent);
async function click(label: string) {
  const target = button(label);
  expect(target, label).not.toBeNull();
  await userEvent.click(target);
}
async function fill(label: string, value: string) {
  await userEvent.fill(byLabel<HTMLInputElement>(label), value);
}

function setup() {
  mocks.rerender = async () => {};
  mocks.connection = {};
  mocks.voiceCapability = true;
  mocks.statusRequests.mockClear();
  mocks.listModels.mockReset();
  mocks.saveWords.mockReset();
  mocks.saveClient.mockReset();
  mocks.saveTranslation.mockReset();
  mocks.speechStatus = {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  };
  mocks.customWords = [];
  mocks.projectWords = [];
  mocks.scope = null;
  mocks.settings.voiceTranscriptionEnvironmentId = null;
  mocks.settings.voiceMicrophone = "";
  mocks.settings.speechLanguage = "auto";
}

it("shows translation for capable models and updates the client preference", async () => {
  setup();
  mocks.speechStatus = {
    supportsTranslation: true,
    translateToEnglish: false,
    effectiveLanguage: "fr",
  };
  mocks.saveTranslation.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "fr",
    gpuDevices: [],
    customWords: [],
    removeFillerWords: true,
    ...mocks.speechStatus,
    translateToEnglish: true,
  });
  mocks.listModels.mockResolvedValue({
    models: [
      {
        id: "model",
        name: "Translation Model",
        description: "French speech",
        languages: ["en", "fr"],
        supportsLanguageDetection: false,
        supportsTranslation: true,
        supportsStreaming: false,
        state: "installed",
        active: true,
        recommended: false,
        size: 100,
        accuracy: 90,
        speed: 90,
      },
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
  expect(container.textContent).toContain("Translate");
  const toggle = byLabel("Translate to English");
  await userEvent.click(toggle);
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechTranslateToEnglish: true });
});

it("ignores a previous environment model response", async () => {
  setup();
  let resolve!: (value: { models: unknown[] }) => void;
  const pending = {
    promise: new Promise<{ models: unknown[] }>((done) => {
      resolve = done;
    }),
    resolve: (value: { models: unknown[] }) => resolve(value),
  };
  mocks.listModels.mockReturnValueOnce(pending.promise);
  await using screen = await render(createElement(VoiceSettingsPanel));
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
  mocks.connection = {};
  await screen.rerender(createElement(VoiceSettingsPanel));
  expect(byLabel("Cancel Model download")).not.toBeNull();
  await act(async () => {
    pending.resolve({ models: [] });
  });
  expect(byLabel("Cancel Model download")).not.toBeNull();
});
it("shows friendly labels for default voice options", async () => {
  setup();
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  const labels = [...container.querySelectorAll("span")].map((span) => span.textContent);
  expect(labels).toContain("My Computer (Primary)");
  expect(labels).toContain("System default");
  expect(labels).toContain("Auto");
  await userEvent.click(byLabel("Transcription acceleration"));
  expect(document.body.textContent).toContain("Test GPU");
  await userEvent.keyboard("{Escape}");
  expect(labels).not.toContain("primary-environment");
  expect(labels).not.toContain("system-default");
  expect(byLabel("Translate to English").getAttribute("aria-disabled")).toBe("true");
});
it("shows saved words as tags with misspelling controls in popovers", async () => {
  setup();
  mocks.customWords = [
    { term: "T3 Code", aliases: ["tea three code"] },
    { term: "Codex", aliases: [] },
  ];
  await using screen = await render(createElement(VoiceSettingsPanel));
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  expect(byLabel("Dictionary entries")).not.toBeNull();
  const wordTag = byLabel("Edit misspellings for T3 Code");
  expect(wordTag.textContent).toContain("T3 Code");
  expect(wordTag.textContent).toContain("(1)");
  await userEvent.click(wordTag);
  expect(byLabel("Edit misspellings for Codex")).not.toBeNull();
  expect(byLabel("Remove T3 Code")).not.toBeNull();
  expect(byLabel("Transcribed as for T3 Code")).not.toBeNull();
  expect(byLabel("Remove alias tea three code from T3 Code")).not.toBeNull();
});
it("bulk adds normalized words and reports skipped entries", async () => {
  setup();
  mocks.customWords = [{ term: "T3 Code", aliases: ["tee three"] }];
  const words = [
    ...mocks.customWords,
    { term: "New Name", aliases: [] },
    { term: "Other", aliases: [] },
  ];
  mocks.saveWords.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "auto",
    effectiveLanguage: "en",
    gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
    customWords: words,
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  await userEvent.click(button("Add multiple words"));
  await fill(
    "Words to add",
    `New   Name\nT3 Code\nTEE THREE\nnew name\n<Other>\n${"x".repeat(51)}`,
  );
  const preview = container.querySelector('[role="status"]')!.textContent;
  expect(preview).toContain("2 words ready to add");
  expect(preview).toContain("3 duplicates");
  expect(preview).toContain("1 over 50 characters");
  await click("Add 2 words");
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechCustomWords: words });
  expect(document.querySelectorAll('[aria-label="Words to add"]')).toHaveLength(0);
  expect(byLabel("Edit misspellings for New Name")).not.toBeNull();
});
it("limits bulk additions to the remaining dictionary capacity", async () => {
  setup();
  mocks.customWords = Array.from({ length: 99 }, (_, index) => ({
    term: `Word ${index}`,
    aliases: [],
  }));
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
  await userEvent.click(button("Add multiple words"));
  await fill("Words to add", "First\nSecond\nThird");
  const preview = container.querySelector('[role="status"]')!.textContent;
  expect(preview).toContain("1 word ready to add");
  expect(preview).toContain("2 over the 100-word limit");
});
it("shows models for the selected language while keeping the active model summary", async () => {
  setup();
  mocks.listModels.mockResolvedValue({
    models: [
      {
        id: "english",
        name: "English Model",
        description: "English speech",
        languages: ["en"],
        supportsLanguageDetection: false,
        state: "installed",
        active: true,
        recommended: true,
        supportsStreaming: false,
        size: 100,
        accuracy: 90,
        speed: 90,
      },
      {
        id: "french",
        name: "French Model",
        description: "French speech",
        languages: ["fr"],
        state: "downloadable",
        active: false,
        recommended: false,
        supportsStreaming: false,
        size: 100,
        accuracy: 90,
        speed: 90,
      },
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  const modelNames = () => [...container.querySelectorAll("span")].map((span) => span.textContent);
  expect(modelNames()).toContain("English Model");
  expect(modelNames()).not.toContain("French Model");
  expect(byLabel<HTMLButtonElement>("Transcription language").disabled).toBe(true);
  expect(paragraphs(container)).toContain("This model only supports English.");
  await userEvent.click(button("All"));
  expect(modelNames()).toContain("English Model");
  expect(modelNames()).toContain("French Model");
  expect(paragraphs(container)).toContain("All models");
  await fill("Search transcription models", "French");
  expect(modelNames()).toContain("French Model");
  await userEvent.click(byLabel("Clear model search"));
  const french = button("French");
  await userEvent.click(french);
  expect(modelNames()).toContain("French Model");
  expect(modelNames()).toContain("English Model");
});
it("orders supported languages by speaker ranking, then alphabetically", async () => {
  setup();
  mocks.listModels.mockResolvedValue({
    models: [
      {
        id: "multilingual",
        name: "Multilingual Model",
        description: "Multilingual speech",
        languages: ["ca", "es", "ar", "hi", "en", "de", "af"],
        supportsLanguageDetection: true,
        state: "installed",
        active: true,
        recommended: false,
        supportsStreaming: false,
        size: 100,
        accuracy: 90,
        speed: 90,
      },
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  expect(byLabel<HTMLButtonElement>("Transcription language").disabled).toBe(false);
  await userEvent.click(byLabel("Transcription language"));
  expect(document.body.textContent).toContain("Auto");
  await userEvent.keyboard("{Escape}");

  const languageList = byLabel("Browse transcription models by language");
  expect([...languageList.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "All",
    "English",
    "Hindi",
    "Spanish",
    "German",
    "Afrikaans",
    "Arabic",
    "Catalan",
  ]);
  const search = byLabel<HTMLInputElement>("Search languages");
  await userEvent.fill(search, "ar");
  expect([...languageList.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Arabic",
  ]);
  await userEvent.click(byLabel("Clear language search"));
  expect(languageList.querySelectorAll("button")).toHaveLength(8);
});
it.each([
  { preference: "auto", languages: ["en", "de", "es", "fr"], expected: "English" },
  { preference: "ja", languages: ["en", "de", "es", "fr"], expected: "English" },
  { preference: "auto", languages: ["fr", "de"], expected: "French" },
])(
  "shows the effective language without Auto for $preference on $languages",
  async ({ preference, languages, expected }) => {
    setup();
    mocks.settings.speechLanguage = preference;
    mocks.listModels.mockResolvedValue({
      models: [
        {
          id: "multilingual",
          name: "Multilingual Model",
          description: "Multilingual speech",
          languages,
          supportsLanguageDetection: false,
          state: "installed",
          active: true,
          recommended: false,
          supportsStreaming: false,
          size: 100,
          accuracy: 90,
          speed: 90,
        },
      ],
    });
    await using screen = await render(createElement(VoiceSettingsPanel));
    mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
    const picker = byLabel("Transcription language");
    expect(picker.textContent).toBe(expected);
    await userEvent.click(picker);
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    );
    expect(options).not.toContain("Auto");
    expect(options).toContain("German");
    const german = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "German",
    )!;
    await userEvent.click(german);
    expect(mocks.saveClient).toHaveBeenCalledWith({ speechLanguage: "de" });
    expect(byLabel("Transcription language").textContent).toBe("German");
  },
);

it("puts the active model first, then installed and downloading models", async () => {
  setup();
  const model = (name: string, state: string, active = false) => ({
    id: name,
    name,
    description: `${name} description`,
    languages: ["en"],
    state,
    active,
    recommended: false,
    supportsStreaming: false,
    size: 100,
    accuracy: 90,
    speed: 90,
  });
  mocks.listModels.mockResolvedValue({
    models: [
      model("Available", "downloadable"),
      model("Downloading", "downloading"),
      model("Installed", "installed"),
      model("Active", "installed", true),
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  expect(paragraphs(container).filter((text) => text.endsWith(" description"))).toEqual([
    "Active description",
    "Installed description",
    "Downloading description",
    "Available description",
  ]);
  const search = byLabel<HTMLInputElement>("Search transcription models");
  await userEvent.fill(search, "installed");
  expect(paragraphs(container).filter((text) => text.endsWith(" description"))).toEqual([
    "Installed description",
  ]);
  await userEvent.fill(search, "missing");
  expect(paragraphs(container)).toContain("No models match your search.");
  await userEvent.click(byLabel("Clear model search"));
  expect(search.value).toBe("");
});
it("uses Handy's editorial ranks within each model state", async () => {
  setup();
  const model = (slug: string, name: string, state: string) => ({
    id: `handy-computer/${slug}-gguf`,
    name,
    description: `${name} description`,
    languages: ["en"],
    state,
    active: false,
    recommended: false,
    supportsStreaming: false,
    size: 100,
    accuracy: 90,
    speed: 90,
  });
  mocks.listModels.mockResolvedValue({
    models: [
      model("canary-180m-flash", "Rank 3", "installed"),
      model("Fun-ASR-MLT-Nano-2512", "Rank 10", "downloadable"),
      model("parakeet-unified-en-0.6b", "Rank 1", "installed"),
      model("Voxtral-Mini-4B-Realtime-2602", "Rank 6", "downloadable"),
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  expect(paragraphs(container).filter((text) => text.endsWith(" description"))).toEqual([
    "Rank 1 description",
    "Rank 3 description",
    "Rank 6 description",
    "Rank 10 description",
  ]);
});
it("sorts unranked models by recommendation, accuracy, speed, then name", async () => {
  setup();
  const model = (name: string, accuracy: number, speed: number, recommended = false) => ({
    id: name,
    name,
    description: `${name} description`,
    languages: ["en"],
    state: "downloadable",
    active: false,
    recommended,
    supportsStreaming: false,
    size: 100,
    accuracy,
    speed,
  });
  mocks.listModels.mockResolvedValue({
    models: [
      model("Zulu", 80, 70),
      model("Alpha", 80, 70),
      model("Faster", 80, 90),
      model("Accurate", 90, 50),
      model("Recommended", 70, 50, true),
    ],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  const { container } = screen;
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));

  expect(paragraphs(container).filter((text) => text.endsWith(" description"))).toEqual([
    "Recommended description",
    "Accurate description",
    "Faster description",
    "Alpha description",
    "Zulu description",
  ]);
});
it("shows cancellation errors without clearing the download state", async () => {
  setup();
  mocks.cancel.mockImplementation(() => Promise.reject(new Error("connection lost")));
  await using screen = await render(createElement(VoiceSettingsPanel));
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
  await act(async () => {
    byLabel<HTMLButtonElement>("Cancel Model download").click();
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      description: "connection lost",
    }),
  );
  expect(byLabel("Cancel Model download")).not.toBeNull();
});

it("saves project words through the originating project scope without copying personal words", async () => {
  setup();
  mocks.scope = {
    target: { projectId: "project-one" },
    scope: { label: "T3 Code", kind: "project", members: [{ id: "project-one" }] },
    search: { project: "project-one" },
    selectScope: vi.fn(),
  };
  mocks.customWords = [{ term: "GitHub", aliases: ["get hub"] }];
  mocks.projectWords = [{ term: "Effect", aliases: [] }];
  mocks.saveWords.mockResolvedValue({
    supported: true,
    acceleration: "auto",
    language: "auto",
    effectiveLanguage: "en",
    gpuDevices: [],
    customWords: mocks.customWords,
    projectCustomWords: [...mocks.projectWords, { term: "Parakeet", aliases: [] }],
  });
  await using screen = await render(createElement(VoiceSettingsPanel));
  mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
  expect(document.querySelectorAll('[aria-label="Transcribed as for GitHub"]')).toHaveLength(0);
  expect(document.querySelectorAll('[aria-label="Remove GitHub"]')).toHaveLength(0);
  await userEvent.click(byLabel("View misspellings for GitHub"));
  await click("Edit personal dictionary");
  await userEvent.keyboard("{Escape}");
  expect(mocks.scope.selectScope).toHaveBeenCalledWith({ project: undefined, checkout: undefined });
  const input = byLabel<HTMLInputElement>("Add a word or phrase");
  await userEvent.fill(input, "github");
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveWords).not.toHaveBeenCalled();
  await userEvent.fill(input, "Parakeet");
  await userEvent.keyboard("{Enter}");
  expect(mocks.saveWords).toHaveBeenCalledWith({
    speechProjectCustomWords: [
      { term: "Effect", aliases: [] },
      { term: "Parakeet", aliases: [] },
    ],
  });
  expect(mocks.saveClient).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  "does not request voice status or models from an older environment (%s)",
  async (capability) => {
    setup();
    mocks.voiceCapability = capability;
    await using screen = await render(createElement(VoiceSettingsPanel));
    const { container } = screen;
    mocks.rerender = () => screen.rerender(createElement(VoiceSettingsPanel));
    expect(mocks.statusRequests).not.toHaveBeenCalled();
    expect(mocks.listModels).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Update its T3 Code server");
  },
);

import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  cancel: vi.fn(),
  listModels: vi.fn(),
  saveWords: vi.fn(),
  saveTranslation: vi.fn(),
  speechStatus: {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  },
  customWords: [] as { term: string; aliases: string[] }[],
  connection: {},
  settings: {
    voiceTranscriptionEnvironmentId: null as string | null,
    voiceMicrophone: "",
    voiceShortcutMode: "auto",
  },
}));
const connectionListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Promise.resolve({
      supported: true,
      acceleration: "auto",
      language: "auto",
      ...mocks.speechStatus,
      gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
      customWords: mocks.customWords,
    }),
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
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof mocks.settings) => unknown) =>
    select(mocks.settings),
  useClientSettingsHydrated: () => true,
  updateClientSettings: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: (value: unknown) => value } }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "environment",
  useEnvironments: () => ({
    environments: [{ environmentId: "environment", label: "My Computer" }],
  }),
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    connectionListeners.add(listener);
    return () => connectionListeners.delete(listener);
  };
  return {
    usePreparedConnection: () =>
      Option.some(useSyncExternalStore(subscribe, () => mocks.connection)),
  };
});
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./VoicePostProcessingSettings", () => ({ VoicePostProcessingSettings: () => null }));
vi.mock("./settingsLayout", () => ({
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

const button = (name: string) => page.getByRole("button", { name, exact: true });
const modelDescriptions = (container: HTMLElement) =>
  [...container.querySelectorAll("p")]
    .map((paragraph) => paragraph.textContent ?? "")
    .filter((text) => text.endsWith(" description"));
const languageButtons = (container: HTMLElement) =>
  [
    ...container.querySelectorAll('[aria-label="Browse transcription models by language"] button'),
  ].map((button) => button.textContent);

function setup() {
  mocks.toast.mockClear();
  mocks.cancel.mockReset();
  mocks.connection = {};
  mocks.listModels.mockReset();
  mocks.saveWords.mockReset();
  mocks.saveTranslation.mockReset();
  mocks.speechStatus = {
    supportsTranslation: false,
    translateToEnglish: false,
    effectiveLanguage: "en",
  };
  mocks.customWords = [];
  mocks.settings.voiceTranscriptionEnvironmentId = null;
  mocks.settings.voiceMicrophone = "";
  const devices = navigator.mediaDevices
    ? vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockResolvedValue([])
    : undefined;
  return { [Symbol.dispose]: () => devices?.mockRestore() };
}

it("shows translation for capable models and updates the environment preference", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));
  expect(_screen.container.textContent).toContain("Translate");
  await userEvent.click(page.getByRole("switch", { name: "Translate to English" }));
  expect(mocks.saveTranslation).toHaveBeenCalledWith(mocks.connection, true);
  await expect
    .element(page.getByRole("switch", { name: "Translate to English" }))
    .toHaveAttribute("aria-checked", "true");
});

it("ignores a previous environment model response", async () => {
  using _env = setup();
  let resolve!: (value: { models: unknown[] }) => void;
  const pending = {
    promise: new Promise<{ models: unknown[] }>((done) => {
      resolve = done;
    }),
    resolve: (value: { models: unknown[] }) => resolve(value),
  };
  mocks.listModels.mockReturnValueOnce(pending.promise);
  await using _screen = await render(createElement(VoiceSettingsPanel));
  await act(async () => {
    mocks.connection = {};
    for (const listener of connectionListeners) listener();
  });
  await expect.element(button("Cancel Model download")).toBeVisible();
  await act(async () => {
    pending.resolve({ models: [] });
  });
  await expect.element(button("Cancel Model download")).toBeVisible();
});
it("shows friendly labels for default voice options", async () => {
  using _env = setup();
  await using _screen = await render(createElement(VoiceSettingsPanel));

  expect(_screen.container.textContent).toContain("My Computer (Primary)");
  expect(_screen.container.textContent).toContain("System default");
  await expect
    .element(
      page
        .getByRole("combobox", { name: "Transcription acceleration" })
        .getByText("Auto", { exact: true }),
    )
    .toBeVisible();
  expect(_screen.container.textContent).not.toContain("primary-environment");
  expect(_screen.container.textContent).not.toContain("system-default");
  await expect.element(page.getByRole("switch", { name: "Translate to English" })).toBeDisabled();
  await userEvent.click(page.getByRole("combobox", { name: "Transcription acceleration" }));
  await expect.element(page.getByRole("option", { name: "Test GPU" })).toBeVisible();
});
it("shows saved words as tags with misspelling controls in popovers", async () => {
  using _env = setup();
  mocks.customWords = [
    { term: "T3 Code", aliases: ["tea three code"] },
    { term: "Codex", aliases: [] },
  ];
  await using _screen = await render(createElement(VoiceSettingsPanel));

  expect(_screen.container.querySelector('[aria-label="Dictionary entries"]')).not.toBeNull();
  await expect.element(button("Edit misspellings for T3 Code")).toHaveTextContent("T3 Code(1)");
  await expect.element(button("Edit misspellings for Codex")).toBeVisible();
  await userEvent.click(button("Edit misspellings for T3 Code"));
  await expect.element(button("Remove T3 Code")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Transcribed as for T3 Code" }))
    .toBeVisible();
  await expect.element(button("Remove alias tea three code from T3 Code")).toBeVisible();
});
it("bulk adds normalized words and reports skipped entries", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  await userEvent.click(button("Add multiple words"));
  await userEvent.fill(
    page.getByRole("textbox", { name: "Words to add" }),
    `New   Name\nT3 Code\nTEE THREE\nnew name\n<Other>\n${"x".repeat(51)}`,
  );
  const preview = _screen.container.querySelector('[role="status"]')!.textContent;
  expect(preview).toContain("2 words ready to add");
  expect(preview).toContain("3 duplicates");
  expect(preview).toContain("1 over 50 characters");
  await userEvent.click(button("Add 2 words"));
  expect(mocks.saveWords).toHaveBeenCalledWith(mocks.connection, words);
  await expect.element(page.getByRole("textbox", { name: "Words to add" })).not.toBeInTheDocument();
  await expect.element(button("Edit misspellings for New Name")).toBeVisible();
});
it("limits bulk additions to the remaining dictionary capacity", async () => {
  using _env = setup();
  mocks.customWords = Array.from({ length: 99 }, (_, index) => ({
    term: `Word ${index}`,
    aliases: [],
  }));
  await using _screen = await render(createElement(VoiceSettingsPanel));
  await userEvent.click(button("Add multiple words"));
  await userEvent.fill(page.getByRole("textbox", { name: "Words to add" }), "First\nSecond\nThird");
  const preview = _screen.container.querySelector('[role="status"]')!.textContent;
  expect(preview).toContain("1 word ready to add");
  expect(preview).toContain("2 over the 100-word limit");
});
it("shows models for the selected language while keeping the active model summary", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  const modelNames = () =>
    [..._screen.container.querySelectorAll("span")].map((span) => span.textContent);
  expect(modelNames()).toContain("English Model");
  expect(modelNames()).not.toContain("French Model");
  await expect
    .element(page.getByRole("combobox", { name: "Transcription language" }))
    .toBeDisabled();
  expect(_screen.container.textContent).toContain("This model only supports English.");
  await userEvent.click(button("French"));
  expect(modelNames()).toContain("French Model");
  expect(modelNames()).toContain("English Model");
});
it("orders supported languages by speaker ranking, then alphabetically", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  await expect
    .element(page.getByRole("combobox", { name: "Transcription language" }))
    .toBeEnabled();
  await userEvent.click(page.getByRole("combobox", { name: "Transcription language" }));
  await expect.element(page.getByRole("option", { name: "Auto", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  expect(languageButtons(_screen.container)).toEqual([
    "English",
    "Hindi",
    "Spanish",
    "German",
    "Afrikaans",
    "Arabic",
    "Catalan",
  ]);
  await userEvent.fill(page.getByRole("searchbox", { name: "Search languages" }), "ar");
  expect(languageButtons(_screen.container)).toEqual(["Arabic"]);
  await userEvent.click(button("Clear language search"));
  expect(languageButtons(_screen.container)).toHaveLength(7);
});
it("puts the active model first, then installed and downloading models", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  expect(modelDescriptions(_screen.container)).toEqual([
    "Active description",
    "Installed description",
    "Downloading description",
    "Available description",
  ]);
  const search = page.getByRole("searchbox", { name: "Search transcription models" });
  await userEvent.fill(search, "installed");
  expect(modelDescriptions(_screen.container)).toEqual(["Installed description"]);
  await userEvent.fill(search, "missing");
  expect(_screen.container.textContent).toContain("No models match your search.");
  await userEvent.click(button("Clear model search"));
  await expect.element(search).toHaveValue("");
});
it("uses Handy's editorial ranks within each model state", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  expect(modelDescriptions(_screen.container)).toEqual([
    "Rank 1 description",
    "Rank 3 description",
    "Rank 6 description",
    "Rank 10 description",
  ]);
});
it("sorts unranked models by recommendation, accuracy, speed, then name", async () => {
  using _env = setup();
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
  await using _screen = await render(createElement(VoiceSettingsPanel));

  expect(modelDescriptions(_screen.container)).toEqual([
    "Recommended description",
    "Accurate description",
    "Faster description",
    "Alpha description",
    "Zulu description",
  ]);
});
it("shows cancellation errors without clearing the download state", async () => {
  using _env = setup();
  mocks.cancel.mockImplementation(() => Promise.reject(new Error("connection lost")));
  await using _screen = await render(createElement(VoiceSettingsPanel));
  await userEvent.click(button("Cancel Model download"));
  await vi.waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "connection lost",
      }),
    ),
  );
  await expect.element(button("Cancel Model download")).toBeVisible();
});

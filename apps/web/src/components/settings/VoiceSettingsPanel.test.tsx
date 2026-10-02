import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
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
  },
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  getEnvironmentSpeechStatus: () =>
    Promise.resolve({
      supported: true,
      acceleration: "auto",
      language: "auto",
      ...mocks.speechStatus,
      gpuDevices: [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }],
      customWords: mocks.customWords,
      projectCustomWords: mocks.projectWords,
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
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => mocks.scope }));
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
    useUpdateClientSettings: () => async (patch: Record<string, unknown>) => {
      mocks.saveClient(patch);
      if (patch.speechCustomWords)
        mocks.customWords = patch.speechCustomWords as typeof mocks.customWords;
      Object.assign(mocks.settings, patch);
      root.update(createElement(VoiceSettingsPanel));
    },
  };
});
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ speechProjectCustomWords: mocks.projectWords }),
  useUpdateScopedSettings:
    () => (patch: { speechProjectCustomWords: typeof mocks.projectWords }) => {
      mocks.saveWords(patch);
      mocks.projectWords = patch.speechProjectCustomWords;
      root.update(createElement(VoiceSettingsPanel));
    },
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
  return { usePreparedConnection: () => Option.some(mocks.connection) };
});
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/popover", () => ({
  Popover: "div",
  PopoverTrigger: "button",
  PopoverContent: "div",
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./VoicePostProcessingSettings", () => ({ VoicePostProcessingSettings: () => null }));
vi.mock("./TranscriptionTest", () => ({
  TranscriptionTest: ({ modelName }: { modelName: string }) =>
    createElement("span", null, modelName),
}));
vi.mock("./MicrophoneTest", () => ({
  MicrophoneTest: ({ microphoneControl }: { microphoneControl: ReactNode }) => microphoneControl,
}));
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

let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
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
});

it("shows translation for capable models and updates the client preference", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });
  expect(root.root.findAllByType("span").some((node) => node.children.includes("Translate"))).toBe(
    true,
  );
  const toggle = root.root.findByProps({ "aria-label": "Translate to English" });
  await act(async () => toggle.props.onCheckedChange(true));
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechTranslateToEnglish: true });
});

it("ignores a previous environment model response", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
  let resolve!: (value: { models: unknown[] }) => void;
  const pending = {
    promise: new Promise<{ models: unknown[] }>((done) => {
      resolve = done;
    }),
    resolve: (value: { models: unknown[] }) => resolve(value),
  };
  mocks.listModels.mockReturnValueOnce(pending.promise);
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });
  mocks.connection = {};
  await act(async () => {
    root.update(createElement(VoiceSettingsPanel));
  });
  expect(root.root.findByProps({ "aria-label": "Cancel Model download" })).toBeDefined();
  await act(async () => {
    pending.resolve({ models: [] });
  });
  expect(root.root.findByProps({ "aria-label": "Cancel Model download" })).toBeDefined();
});
it("shows friendly labels for default voice options", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  const labels = root.root.findAllByType("span").map((span) => span.children.join(""));
  expect(labels).toContain("My Computer (Primary)");
  expect(labels).toContain("System default");
  expect(labels).toContain("Auto");
  expect(root.root.findAllByType("option").map((option) => option.children.join(""))).toContain(
    "Test GPU",
  );
  expect(labels).not.toContain("primary-environment");
  expect(labels).not.toContain("system-default");
  expect(root.root.findByProps({ "aria-label": "Translate to English" }).props.disabled).toBe(true);
});
it("shows saved words as tags with misspelling controls in popovers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
  mocks.customWords = [
    { term: "T3 Code", aliases: ["tea three code"] },
    { term: "Codex", aliases: [] },
  ];
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  expect(root.root.findByProps({ "aria-label": "Dictionary entries" })).toBeDefined();
  const wordTag = root.root.findByProps({ "aria-label": "Edit misspellings for T3 Code" });
  expect(wordTag.children[0]).toBe("T3 Code");
  expect(wordTag.findByType("span").children.join("")).toBe("(1)");
  expect(root.root.findByProps({ "aria-label": "Edit misspellings for Codex" })).toBeDefined();
  expect(root.root.findByProps({ "aria-label": "Remove T3 Code" })).toBeDefined();
  expect(root.root.findByProps({ "aria-label": "Transcribed as for T3 Code" })).toBeDefined();
  expect(
    root.root.findByProps({ "aria-label": "Remove alias tea three code from T3 Code" }),
  ).toBeDefined();
});
it("bulk adds normalized words and reports skipped entries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  await act(async () => root.root.findByProps({ children: "Add multiple words" }).props.onClick());
  const paste = root.root.findByProps({ "aria-label": "Words to add" });
  await act(async () =>
    paste.props.onChange({
      target: {
        value: `New   Name\nT3 Code\nTEE THREE\nnew name\n<Other>\n${"x".repeat(51)}`,
      },
    }),
  );
  const preview = root.root.findByProps({ role: "status" }).children.join("");
  expect(preview).toContain("2 words ready to add");
  expect(preview).toContain("3 duplicates");
  expect(preview).toContain("1 over 50 characters");
  const addBulk = root.root
    .findAllByType("button")
    .find((button) => button.children.join("") === "Add 2 words");
  expect(addBulk).toBeDefined();
  await act(async () => addBulk!.props.onClick());
  expect(mocks.saveClient).toHaveBeenCalledWith({ speechCustomWords: words });
  expect(root.root.findAllByProps({ "aria-label": "Words to add" })).toHaveLength(0);
  expect(root.root.findByProps({ "aria-label": "Edit misspellings for New Name" })).toBeDefined();
});
it("limits bulk additions to the remaining dictionary capacity", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
  mocks.customWords = Array.from({ length: 99 }, (_, index) => ({
    term: `Word ${index}`,
    aliases: [],
  }));
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });
  await act(async () => root.root.findByProps({ children: "Add multiple words" }).props.onClick());
  await act(async () =>
    root.root.findByProps({ "aria-label": "Words to add" }).props.onChange({
      target: { value: "First\nSecond\nThird" },
    }),
  );
  const preview = root.root.findByProps({ role: "status" }).children.join("");
  expect(preview).toContain("1 word ready to add");
  expect(preview).toContain("2 over the 100-word limit");
});
it("shows models for the selected language while keeping the active model summary", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  const modelNames = () => root.root.findAllByType("span").map((span) => span.children.join(""));
  expect(modelNames()).toContain("English Model");
  expect(modelNames()).not.toContain("French Model");
  expect(
    root.root.findByProps({ "aria-label": "Transcription language" }).parent?.props.disabled,
  ).toBe(true);
  expect(root.root.findAllByType("p").map((p) => p.children.join(""))).toContain(
    "This model only supports English.",
  );
  await act(async () => root.root.findByProps({ children: "All" }).props.onClick());
  expect(modelNames()).toContain("English Model");
  expect(modelNames()).toContain("French Model");
  expect(root.root.findAllByType("p").map((p) => p.children.join(""))).toContain("All models");
  await act(async () =>
    root.root.findByProps({ "aria-label": "Search transcription models" }).props.onChange({
      target: { value: "French" },
    }),
  );
  expect(modelNames()).toContain("French Model");
  await act(async () =>
    root.root.findByProps({ "aria-label": "Clear model search" }).props.onClick(),
  );
  const french = root.root.findByProps({ children: "French" });
  await act(async () => french.props.onClick());
  expect(modelNames()).toContain("French Model");
  expect(modelNames()).toContain("English Model");
});
it("orders supported languages by speaker ranking, then alphabetically", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  expect(
    root.root.findByProps({ "aria-label": "Transcription language" }).parent?.props.disabled,
  ).toBe(false);
  expect(root.root.findAllByType("option").map((option) => option.children.join(""))).toContain(
    "Auto",
  );

  const languageList = root.root.findByProps({
    "aria-label": "Browse transcription models by language",
  });
  expect(languageList.findAllByType("button").map((button) => button.children.join(""))).toEqual([
    "All",
    "English",
    "Hindi",
    "Spanish",
    "German",
    "Afrikaans",
    "Arabic",
    "Catalan",
  ]);
  const search = root.root.findByProps({ "aria-label": "Search languages" });
  await act(async () => search.props.onChange({ target: { value: "ar" } }));
  expect(languageList.findAllByType("button").map((button) => button.children.join(""))).toEqual([
    "Arabic",
  ]);
  await act(async () =>
    root.root.findByProps({ "aria-label": "Clear language search" }).props.onClick(),
  );
  expect(languageList.findAllByType("button")).toHaveLength(8);
});
it("puts the active model first, then installed and downloading models", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  expect(
    root.root
      .findAllByType("p")
      .map((paragraph) => paragraph.children.join(""))
      .filter((text) => text.endsWith(" description")),
  ).toEqual([
    "Active description",
    "Installed description",
    "Downloading description",
    "Available description",
  ]);
  const search = root.root.findByProps({ "aria-label": "Search transcription models" });
  await act(async () => search.props.onChange({ target: { value: "installed" } }));
  expect(
    root.root
      .findAllByType("p")
      .map((paragraph) => paragraph.children.join(""))
      .filter((text) => text.endsWith(" description")),
  ).toEqual(["Installed description"]);
  await act(async () => search.props.onChange({ target: { value: "missing" } }));
  expect(root.root.findAllByType("p").map((paragraph) => paragraph.children.join(""))).toContain(
    "No models match your search.",
  );
  await act(async () =>
    root.root.findByProps({ "aria-label": "Clear model search" }).props.onClick(),
  );
  expect(search.props.value).toBe("");
});
it("uses Handy's editorial ranks within each model state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  expect(
    root.root
      .findAllByType("p")
      .map((paragraph) => paragraph.children.join(""))
      .filter((text) => text.endsWith(" description")),
  ).toEqual([
    "Rank 1 description",
    "Rank 3 description",
    "Rank 6 description",
    "Rank 10 description",
  ]);
});
it("sorts unranked models by recommendation, accuracy, speed, then name", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });

  expect(
    root.root
      .findAllByType("p")
      .map((paragraph) => paragraph.children.join(""))
      .filter((text) => text.endsWith(" description")),
  ).toEqual([
    "Recommended description",
    "Accurate description",
    "Faster description",
    "Alpha description",
    "Zulu description",
  ]);
});
it("shows cancellation errors without clearing the download state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
  mocks.cancel.mockImplementation(() => Promise.reject(new Error("connection lost")));
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });
  await act(async () => {
    root.root.findByProps({ "aria-label": "Cancel Model download" }).props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      description: "connection lost",
    }),
  );
  expect(root.root.findByProps({ "aria-label": "Cancel Model download" })).toBeDefined();
});

it("saves project words through the originating project scope without copying personal words", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", { setInterval, clearInterval });
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
  await act(async () => {
    root = create(createElement(VoiceSettingsPanel));
  });
  expect(root.root.findAllByProps({ "aria-label": "Transcribed as for GitHub" })).toHaveLength(0);
  expect(root.root.findAllByProps({ "aria-label": "Remove GitHub" })).toHaveLength(0);
  await act(async () =>
    root.root.findByProps({ children: "Edit personal dictionary" }).props.onClick(),
  );
  expect(mocks.scope.selectScope).toHaveBeenCalledWith({ project: undefined, checkout: undefined });
  const input = root.root.findByProps({ "aria-label": "Add a word or phrase" });
  await act(async () => input.props.onChange({ target: { value: "github" } }));
  await act(async () => input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() }));
  expect(mocks.saveWords).not.toHaveBeenCalled();
  await act(async () => input.props.onChange({ target: { value: "Parakeet" } }));
  await act(async () => input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() }));
  expect(mocks.saveWords).toHaveBeenCalledWith({
    speechProjectCustomWords: [
      { term: "Effect", aliases: [] },
      { term: "Parakeet", aliases: [] },
    ],
  });
  expect(mocks.saveClient).not.toHaveBeenCalled();
});

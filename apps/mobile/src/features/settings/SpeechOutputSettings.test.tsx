import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type SpeechOutputDestination,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { SettingsSpeechRouteScreen } from "./SettingsSpeechRouteScreen";
import { SpeechOutputSettings } from "./SpeechOutputSettings";
import { useSpeechOutputDestination } from "../voice-output/useSpeechOutputDestination";

vi.mock("gt-react-native", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react-native")>();
  return { ...gt, useGT: () => gt.mFallback };
});
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => mocks.thread }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ presentation: mocks.presentation }),
}));
vi.mock("./SystemSpeechSettings", () => ({ SystemSpeechSettings: () => null }));
const mocks = vi.hoisted(() => ({
  preferences: {} as { speechOutputDestination?: SpeechOutputDestination | null },
  thread: null as { projectId: ProjectId } | null,
  presentation: null as EnvironmentPresentation | null,
  save: vi.fn(),
  update: vi.fn(),
  alert: vi.fn(),
  readConfig: vi.fn(),
  environments: [] as EnvironmentPresentation[],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(mocks.preferences),
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  saveMobilePreferences: {},
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: () => {}, alert: mocks.alert }));
vi.mock("../voice-output/useElevenLabsVoices", () => ({
  useElevenLabsVoices: () => ({ voices: [], loading: false, failed: false, connected: true }),
}));
vi.mock("../voice-output/SpeechPlaybackSpeed", async () => {
  const { useSpeechOutputDestination } = await import("../voice-output/useSpeechOutputDestination");
  return {
    SpeechPlaybackSpeed: () => {
      const controls = useSpeechOutputDestination();
      return <button onClick={() => controls.setPlaybackRate(1.5)}>Speed picker result</button>;
    },
  };
});
vi.mock("../../components/ui/AppText", () => ({ AppTextInput: () => null }));
vi.mock("../../components/ui/SecretTextInput", () => ({ SecretTextInput: () => null }));
vi.mock("../voice-output/voiceOutput", () => ({
  voiceOutput: { stop: () => {}, getSnapshot: () => ({ owner: null }) },
}));
vi.mock("../voice-output/useSpeechVoiceCatalog", () => ({
  useSpeechVoiceCatalog: () => ({
    runtime: { state: "not-installed", platform: "linux-x64" },
    canManage: true,
    run: () => {},
    providers: [],
    voices: [],
  }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    detail,
    onPress,
  }: {
    label: string;
    detail?: string;
    onPress: () => void;
  }) => (
    <button onClick={onPress}>
      {label}
      {detail ? `: ${detail}` : ""}
    </button>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({
    children,
    title,
    onClose,
  }: {
    children?: ReactNode;
    title: string;
    onClose: () => void;
  }) => (
    <div>
      <button onClick={onClose}>{`Close ${title}`}</button>
      {children}
    </div>
  ),
}));
vi.mock("./LocalSpeechVoices", () => ({ LocalSpeechVoices: () => null }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () =>
    new Set(mocks.environments.map((environment) => environment.environmentId)),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ title: "Scope", items: [] }),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.environments,
    selectedProjectKey: "speech-project",
    projectGroups: [
      {
        key: "speech-project",
        members: mocks.environments.map((environment) => ({
          project: { id: "speech-project", environmentId: environment.environmentId },
        })),
      },
    ],
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: {}, configValueAtom: () => ({}) },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => mocks.readConfig() },
}));
vi.mock("../../state/use-atom-command", async () => {
  const { saveMobilePreferences } = await import("../../state/preferences");
  return {
    useAtomCommand: (command: unknown) =>
      command === saveMobilePreferences ? mocks.save : mocks.update,
  };
});

it("defaults off and changes the playback destination on this device without changing server settings", async () => {
  mocks.thread = null;
  mocks.presentation = null;
  mocks.preferences = {};
  mocks.alert.mockReset();
  mocks.update.mockReset();
  mocks.save.mockReset();
  mocks.save.mockImplementation((patch: typeof mocks.preferences) => {
    mocks.preferences = { ...mocks.preferences, ...patch };
    return Promise.resolve(AsyncResult.success(mocks.preferences));
  });
  const environmentId = EnvironmentId.make("remote-speech");
  const environment = {
    environmentId,
    label: "Server",
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { voiceSynthesis: true } },
    },
  } as unknown as EnvironmentPresentation;
  const container = document.createElement("div");
  const root = createRoot(container);
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const click = (label: string) =>
    act(() => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      button.click();
    });
  try {
    act(() => root.render(<SpeechOutputSettings environments={[environment]} />));
    click("Read aloud with: Off");
    click("Server");
    expect(mocks.preferences.speechOutputDestination).toEqual({ environmentId, engine: "piper" });
    expect(container.textContent).toContain("Download Piper");
    click("Read aloud with: Server");
    click("OpenAI");
    expect(mocks.preferences.speechOutputDestination).toEqual({ environmentId, engine: "piper" });
    click("Close Add OpenAI API key");
    click("Read aloud with: Server");
    click("ElevenLabs");
    expect(mocks.preferences.speechOutputDestination).toEqual({ environmentId, engine: "piper" });
    click("Close Add ElevenLabs API key");
    click("Read aloud with: Server");
    click("OpenAI");
    act(() => root.render(<SpeechOutputSettings key="reloaded" environments={[environment]} />));
    expect(mocks.preferences.speechOutputDestination).toEqual({ environmentId, engine: "piper" });
    expect(container.textContent).not.toContain("Save key");
    const configured = {
      ...environment,
      serverConfig: {
        ...environment.serverConfig!,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          cloudSpeechCredentials: {
            ...DEFAULT_SERVER_SETTINGS.cloudSpeechCredentials,
            openai: "••••••",
          },
          speechOutput: { ...DEFAULT_SERVER_SETTINGS.speechOutput, elevenLabsApiKey: "••••••" },
        },
      },
    };
    act(() => root.render(<SpeechOutputSettings key="configured" environments={[configured]} />));
    click("Read aloud with: Server");
    click("OpenAI");
    expect(mocks.preferences.speechOutputDestination).toEqual({ environmentId, engine: "openai" });
    click("Read aloud with: OpenAI via Server");
    click("ElevenLabs");
    expect(mocks.preferences.speechOutputDestination).toEqual({
      environmentId,
      engine: "elevenlabs",
    });
    click("Read aloud with: ElevenLabs via Server");
    click("Off");
    expect(mocks.preferences.speechOutputDestination).toBeNull();
    mocks.save.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("storage unavailable"))),
    );
    click("Read aloud with: Off");
    await act(async () => {
      click("OpenAI");
    });
    expect(mocks.preferences.speechOutputDestination).toBeNull();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not save speech output choice",
      "Your previous destination is still selected. Please try again.",
    );
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.save.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("rate storage unavailable"))),
    );
    await act(async () => click("Speed picker result"));
    expect(mocks.alert).toHaveBeenLastCalledWith(
      "Could not save playback speed",
      "Your previous playback speed is still selected. Please try again.",
    );
  } finally {
    act(() => root.unmount());
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

it("keeps a closing speed picker's update when a project destination save is pending", async () => {
  mocks.thread = null;
  mocks.presentation = null;
  mocks.preferences = {};
  mocks.save.mockReset();
  mocks.update.mockReset();
  const environmentId = EnvironmentId.make("scoped-speech");
  const projectId = ProjectId.make("speech-project");
  let persisted = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
  });
  mocks.environments = [
    {
      environmentId,
      label: "Server",
      connection: { phase: "connected" },
      serverConfig: {
        settings: persisted,
        environment: { capabilities: { voiceSynthesis: true } },
      },
    } as unknown as EnvironmentPresentation,
  ];
  mocks.readConfig.mockImplementation(() => ({
    ...mocks.environments[0]!.serverConfig,
    settings: persisted,
  }));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let count = 0;
  let finished = 0;
  mocks.update.mockImplementation(
    async ({ input }: { input: { patch: Parameters<typeof applyServerSettingsPatch>[1] } }) => {
      if (++count === 1) {
        started.resolve();
        await release.promise;
      }
      persisted = applyServerSettingsPatch(persisted, input.patch);
      if (++finished === 1) {
        persisted = applyServerSettingsPatch(persisted, {
          projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
        });
      }
      if (finished === 2) completed.resolve();
      return AsyncResult.success(persisted);
    },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const click = (label: string) =>
    act(() => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      button.click();
    });
  try {
    act(() => root.render(<SettingsSpeechRouteScreen />));
    click("Read aloud with: Off");
    click("Server");
    await started.promise;
    click("Speed picker result");
    await act(async () => {
      release.resolve();
      await completed.promise;
    });
    expect(persisted.projectSettingsOverrides[projectId]).toMatchObject({
      speechPlaybackDestination: { environmentId, engine: "piper" },
      speechPlaybackRate: 1.5,
      defaultAutoPull: true,
    });
    expect(persisted.speechPlaybackDestination).toBeUndefined();
    expect(persisted.speechPlaybackRate).toBeUndefined();
  } finally {
    act(() => root.unmount());
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

it("preserves pending thread speech changes until settings refresh and drops failed writes", async () => {
  mocks.preferences = {};
  mocks.alert.mockReset();
  mocks.save.mockReset();
  mocks.update.mockReset();
  const environmentId = EnvironmentId.make("thread-speech");
  const projectId = ProjectId.make("thread-project");
  const threadRef: ScopedThreadRef = { environmentId, threadId: ThreadId.make("speech-thread") };
  const original = { environmentId, engine: "piper" as const, voice: "original" };
  const chosen = { environmentId, engine: "openai" as const, voice: "nova" };
  let persisted = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    projectSettingsOverrides: {
      [projectId]: {
        defaultAutoPull: false,
        speechPlaybackDestination: original,
        speechPlaybackRate: 1,
      },
    },
  });
  mocks.thread = { projectId };
  mocks.presentation = {
    environmentId,
    serverConfig: { settings: persisted },
  } as unknown as EnvironmentPresentation;
  mocks.readConfig.mockImplementation(() => mocks.presentation?.serverConfig);
  mocks.update.mockImplementation(
    async ({ input }: { input: { patch: Parameters<typeof applyServerSettingsPatch>[1] } }) => {
      persisted = applyServerSettingsPatch(persisted, input.patch);
      return AsyncResult.success(persisted);
    },
  );
  function ThreadControls() {
    const controls = useSpeechOutputDestination(threadRef);
    return (
      <>
        <button onClick={() => controls.choose(chosen)}>Choose destination</button>
        {([1, 1.5, 2] as const).map((rate) => (
          <button key={rate} onClick={() => controls.setPlaybackRate(rate)}>
            {`Speed ${rate}`}
          </button>
        ))}
      </>
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const click = (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
  };
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<ThreadControls />));
    await act(async () => {
      click("Choose destination");
      click("Speed 1.5");
    });
    expect(persisted.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: false,
      speechPlaybackDestination: chosen,
      speechPlaybackRate: 1.5,
    });

    persisted = applyServerSettingsPatch(persisted, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, speechPlaybackDestination: original },
      },
    });
    mocks.presentation = {
      ...mocks.presentation!,
      serverConfig: { ...mocks.presentation!.serverConfig!, settings: persisted },
    };
    act(() => root.render(<ThreadControls />));
    await act(async () => click("Speed 2"));
    expect(persisted.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      speechPlaybackDestination: original,
      speechPlaybackRate: 2,
    });

    mocks.update.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("write failed"))));
    await act(async () => click("Choose destination"));
    await act(async () => click("Speed 1"));
    expect(persisted.projectSettingsOverrides[projectId]).toEqual({
      defaultAutoPull: true,
      speechPlaybackDestination: original,
      speechPlaybackRate: 1,
    });
    for (const speedFails of [false, true]) {
      mocks.alert.mockClear();
      const destinationSave = Promise.withResolvers<ReturnType<typeof AsyncResult.failure>>();
      mocks.update.mockImplementationOnce(() => destinationSave.promise);
      if (speedFails)
        mocks.update.mockResolvedValueOnce(
          AsyncResult.failure(Cause.fail(new Error("speed failed"))),
        );
      await act(async () => {
        click("Choose destination");
        click("Speed 1.5");
      });
      persisted = applyServerSettingsPatch(persisted, {
        projectSettingsOverrides: {
          [projectId]: { ...persisted.projectSettingsOverrides[projectId], defaultAutoPull: false },
        },
      });
      mocks.presentation = {
        ...mocks.presentation!,
        serverConfig: { ...mocks.presentation!.serverConfig!, settings: persisted },
      };
      await act(async () => {
        destinationSave.resolve(AsyncResult.failure(Cause.fail(new Error("destination failed"))));
      });
      expect(persisted.projectSettingsOverrides[projectId]).toEqual({
        defaultAutoPull: false,
        speechPlaybackDestination: original,
        speechPlaybackRate: speedFails ? 1 : 1.5,
      });
      expect(mocks.alert).toHaveBeenCalledWith(
        "Could not save speech output choice",
        "Your previous destination is still selected. Please try again.",
      );
      await act(async () => click("Speed 1"));
      expect(persisted.projectSettingsOverrides[projectId]?.speechPlaybackDestination).toEqual(
        original,
      );
    }
    expect(mocks.save).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    mocks.thread = null;
    mocks.presentation = null;
  }
});

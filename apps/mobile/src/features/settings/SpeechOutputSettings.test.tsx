import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type SpeechOutputDestination,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import { SpeechOutputSettings } from "./SpeechOutputSettings";

const mocks = vi.hoisted(() => ({
  preferences: {} as { speechOutputDestination?: SpeechOutputDestination | null },
  save: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(mocks.preferences),
  useAtomSet: () => mocks.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: () => {} }));
vi.mock("../voice-output/useElevenLabsVoices", () => ({
  useElevenLabsVoices: () => ({ voices: [], loading: false, failed: false, connected: true }),
}));
vi.mock("../voice-output/SpeechPlaybackSpeed", () => ({ SpeechPlaybackSpeed: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppTextInput: () => null }));
vi.mock("../../components/ui/SecretTextInput", () => ({ SecretTextInput: () => null }));
vi.mock("../voice-output/voiceOutput", () => ({ voiceOutput: { stop: () => {} } }));
vi.mock("../voice-output/useSpeechVoiceCatalog", () => ({
  useSpeechVoiceCatalog: () => ({
    runtime: { state: "not-installed", platform: "linux-x64" },
    canManage: true,
    run: () => {},
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
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

it("defaults off and changes the playback destination on this device without changing server settings", () => {
  mocks.preferences = {};
  mocks.update.mockReset();
  mocks.save.mockReset();
  mocks.save.mockImplementation((patch: typeof mocks.preferences) => {
    mocks.preferences = { ...mocks.preferences, ...patch };
    return Promise.resolve();
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
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

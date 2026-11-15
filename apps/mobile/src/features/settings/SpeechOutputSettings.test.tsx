import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../../state/environments";
import { SpeechOutputSettings } from "./SpeechOutputSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: (props: {
    accessibilityLabel: string;
    defaultValue: string;
    onEndEditing: (event: { nativeEvent: { text: string } }) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      defaultValue={props.defaultValue}
      onBlur={(event) => props.onEndEditing({ nativeEvent: { text: event.target.value } })}
    />
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: () => null }));
vi.mock("../../components/ui/Sheet", () => ({ Sheet: () => null }));
vi.mock("./LocalSpeechVoices", () => ({ LocalSpeechVoices: () => null }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

it("preserves an executable save when the engine changes before settings refresh", () => {
  mocks.update.mockReset();
  let saved = DEFAULT_SERVER_SETTINGS;
  mocks.update.mockImplementation(({ input }: { input: { patch: ServerSettingsPatch } }) => {
    saved = applyServerSettingsPatch(saved, input.patch);
  });
  const environment = {
    environmentId: EnvironmentId.make("mobile-speech"),
    label: "Local",
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  } as unknown as EnvironmentPresentation;
  const container = document.createElement("div");
  const root = createRoot(container);
  const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<SpeechOutputSettings environment={environment} />));
    const executable = container.querySelector("input")!;
    const openai = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "OpenAI",
    )!;
    act(() => {
      executable.value = "/custom/piper";
      executable.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      openai.click();
    });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(saved.speechOutput).toEqual({
      ...DEFAULT_SERVER_SETTINGS.speechOutput,
      piperExecutable: "/custom/piper",
      engine: "openai",
    });
  } finally {
    act(() => root.unmount());
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

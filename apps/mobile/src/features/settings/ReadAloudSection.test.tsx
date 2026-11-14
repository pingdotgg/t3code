import {
  DEFAULT_READ_ALOUD_SETTINGS,
  EMPTY_SPEECH_SYNTHESIS_CATALOG,
  EnvironmentId,
  READ_ALOUD_LABELS,
  type ReadAloudSettings,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ReadAloudSection } from "./ReadAloudSection";

const mocks = vi.hoisted(() => ({
  settings: null as ReadAloudSettings | null,
  failures: 0,
  pendingKey: null as Promise<void> | null,
  catalogError: "",
  connection: { environmentId: "voice-host" },
  playback: { id: null, status: "idle" },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({ readAloud: mocks.settings }),
  useAtomSet: () => (patch: { readAloud: ReadAloudSettings }) => {
    mocks.settings = patch.readAloud;
  },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "voice-host", label: "Voice host" }] }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  usePreparedConnection: () => Option.some(mocks.connection),
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText(value: string): void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("expo-speech", () => ({ getAvailableVoicesAsync: async () => [] }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: "alert";
  }) => <p role={accessibilityRole}>{children}</p>,
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { children?: ReactNode }) => <section>{props.children}</section>,
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: () => null }));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress(): void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../read-aloud/playback", () => ({
  readAloudController: { subscribe: () => () => {}, getSnapshot: () => mocks.playback, stop() {} },
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  getSpeechSynthesisModels: () => "catalog",
  setCloudSpeechKey: () => "key",
}));
vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: async (operation: string) => {
    if (operation === "catalog")
      return {
        ...EMPTY_SPEECH_SYNTHESIS_CATALOG,
        apiKeyProvider: "xai",
        error: mocks.catalogError,
      };
    if (mocks.pendingKey) return mocks.pendingKey;
    if (mocks.failures-- > 0) throw new Error("key operation failed");
  },
}));

async function mount() {
  await using cleanup = new AsyncDisposableStack();
  const reactGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  };
  const previous = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  cleanup.defer(() => {
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup.defer(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      host.remove();
    }
  });
  await act(async () => root.render(<ReadAloudSection />));
  const owned = cleanup.move();
  return {
    host,
    async [Symbol.asyncDispose]() {
      await owned.disposeAsync();
    },
  };
}

async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it.each(["retry", "source change"])("clears a failed key operation after %s", async (action) => {
  mocks.settings = {
    ...DEFAULT_READ_ALOUD_SETTINGS,
    provider: "xai",
    environmentId: EnvironmentId.make("voice-host"),
  };
  mocks.failures = 1;
  mocks.pendingKey = null;
  mocks.catalogError = "";
  await using screen = await mount();
  await click(screen.host, "Remove shared API key");
  expect(screen.host.querySelector('[role="alert"]')?.textContent).toContain("Could not remove");
  if (action === "retry") {
    mocks.catalogError = "Later catalog error";
    await click(screen.host, "Remove shared API key");
  } else {
    await click(screen.host, "Speech provider");
    await click(screen.host, "Off");
  }
  if (action === "retry")
    expect(screen.host.querySelector('[role="alert"]')?.textContent).toBe("Later catalog error");
  else expect(screen.host.querySelector('[role="alert"]')).toBeNull();
});

it.each(["save", "remove"])(
  "ignores stale key %s completions after switching providers",
  async (operation) => {
    mocks.settings = {
      ...DEFAULT_READ_ALOUD_SETTINGS,
      provider: "xai",
      environmentId: EnvironmentId.make("voice-host"),
    };
    mocks.failures = 0;
    mocks.catalogError = "";
    const pending = Promise.withResolvers<void>();
    mocks.pendingKey = pending.promise;
    await using screen = await mount();
    const draft = () =>
      screen.host.querySelector<HTMLInputElement>('input[aria-label="Read-aloud API key"]')!;
    const enter = async (value: string) =>
      act(async () => {
        draft().value = value;
        draft().dispatchEvent(new Event("input", { bubbles: true }));
      });
    await enter("original key");
    await click(screen.host, operation === "save" ? "Save key" : "Remove shared API key");
    await click(screen.host, "Speech provider");
    await click(screen.host, READ_ALOUD_LABELS.openai);
    await enter("new provider draft");
    await act(async () => {
      if (operation === "save") pending.resolve();
      else pending.reject(new Error("old provider failed"));
      await pending.promise.catch(() => {});
    });
    expect(draft().value).toBe("new provider draft");
    expect(screen.host.querySelector('[role="alert"]')).toBeNull();
  },
);

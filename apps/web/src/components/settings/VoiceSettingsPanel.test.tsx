import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  cancel: vi.fn(),
  listModels: vi.fn(),
  connection: {},
  settings: {
    voiceTranscriptionEnvironmentId: null as string | null,
    voiceMicrophone: "",
  },
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  getEnvironmentSpeechStatus: () => Promise.resolve({ supported: true }),
  getEnvironmentSpeechModels: () =>
    mocks.listModels() ??
    Promise.resolve({
      models: [
        {
          id: "model",
          name: "Model",
          languages: ["en"],
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
  useUpdateClientSettings: () => vi.fn(),
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
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: "div",
  SettingsSection: "section",
  SettingsRow: ({ control }: { control: ReactNode }) => control,
}));
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  mocks.listModels.mockReset();
  mocks.settings.voiceTranscriptionEnvironmentId = null;
  mocks.settings.voiceMicrophone = "";
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
  expect(labels).not.toContain("primary-environment");
  expect(labels).not.toContain("system-default");
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

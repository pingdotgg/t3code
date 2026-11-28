import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ExtensionInfo } from "@t3tools/contracts";

const { state, Children } = vi.hoisted(() => ({
  state: { entries: [] as ExtensionInfo[] },
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({ View: Children, Platform: { OS: "android" } }));
vi.mock("react-native-webview", () => ({
  WebView: () => <iframe title="Extension panel" sandbox="" />,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/extensions", () => ({
  extensionEnvironment: {
    state: () => ({}),
    invoke: {},
    panel: {},
    settings: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.entries, error: null, isPending: true }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../lib/htmlRenderTheme", () => ({ mobileHtmlRenderTheme: () => ({}) }));
vi.mock("./appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({}),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/ExtensionSettingsFields", () => ({ ExtensionSettingsFields: () => null }));
vi.mock("./useExtensionPanelContent", () => ({
  useExtensionPanelContent: () => ({ data: "<button>Save</button>", isPending: false }),
}));

import { MobileExtensionPanel } from "./MobileExtensionPanel";
import { SettingsExtensionPageRouteScreen } from "./SettingsExtensionPageRouteScreen";

const environmentId = "test" as EnvironmentId;
function entry(): ExtensionInfo {
  return {
    manifest: {
      id: "test.lifecycle",
      description: "Lifecycle fixture",
      name: "Lifecycle",
      version: "1.0.0",
      apiVersion: 1,
      main: "main.mjs",
      settingsPages: [{ id: "page", title: "Lifecycle", panelId: "panel" }],
    },
    source: "/extension",
    sourceType: "local",
    enabled: true,
    status: "running",
    runtimeId: "first",
    settings: {},
  };
}
async function screen() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: async (node: ReactNode) => {
      await act(async () => root.render(node));
    },
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("unmounts an open native panel when its owning registration stops or disappears", async () => {
  const opened = entry();
  state.entries = [opened];
  await using view = await screen();
  const render = () =>
    view.render(<MobileExtensionPanel environmentId={environmentId} entry={opened} html="hello" />);
  await render();
  expect(view.container.querySelector("iframe")).not.toBeNull();
  state.entries = [{ ...opened, enabled: false, status: "disabled" }];
  await render();
  expect(view.container.querySelector("iframe")).toBeNull();
  state.entries = [{ ...opened, runtimeId: "second" }];
  await render();
  expect(view.container.querySelector("iframe")).toBeNull();
  state.entries = [];
  await render();
  expect(view.container.querySelector("iframe")).toBeNull();
});

it("replaces an open Settings page with unavailable after disable and uninstall", async () => {
  const opened = entry();
  state.entries = [opened];
  await using view = await screen();
  const render = () =>
    view.render(
      <SettingsExtensionPageRouteScreen
        route={{ params: { environmentId, extensionId: opened.manifest.id, pageId: "page" } }}
      />,
    );
  await render();
  expect(view.container.querySelector("iframe")).not.toBeNull();
  for (const entries of [[{ ...opened, enabled: false, status: "disabled" as const }], []]) {
    state.entries = entries;
    await render();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).toContain("unavailable");
    expect(view.container.textContent).not.toContain("Loading");
  }
});

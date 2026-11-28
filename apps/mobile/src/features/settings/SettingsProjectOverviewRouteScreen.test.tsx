import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { update: vi.fn() },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: Children,
  Pressable: Children,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ isFocused: () => false }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: Children,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: vi.fn() }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => null,
}));
vi.mock("./ProjectRepositoriesSection", () => ({ ProjectRepositoriesSection: () => null }));
vi.mock("./settings-navigation", () => ({ leaveSettingsPage: vi.fn() }));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => false,
}));
vi.mock("../layout/workspace/workspace-tab-navigation", () => ({
  DEFAULT_SETTINGS_PAGE: "general",
}));
vi.mock("../../state/use-composer-drafts", () => ({}));
vi.mock("../../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { delete: {}, update: {} } }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["local", "remote"]),
}));
vi.mock("./settings-environment-filter", () => {
  const local = { environmentId: "local", id: "local-project", title: "Old name" };
  const remote = { environmentId: "remote", id: "remote-project", title: "Old name" };
  const target = (environmentId: string) => ({
    environmentId,
    label: environmentId,
    serverConfig: { environment: { capabilities: { projectOrganization: true } } },
  });
  return {
    useSettingsEnvironmentFilter: () => ({
      availableTargets: [target("local"), target("remote")],
      // The filter shows one machine; the project also has a checkout on the other.
      selectedTargets: [target("local")],
      projectGroups: [
        {
          key: "github.com/acme/app",
          pinned: false,
          archived: false,
          members: [{ project: local }, { project: remote }],
        },
      ],
      selectedProjectKey: "github.com/acme/app",
      selectProject: vi.fn(),
      getSelectedProjectKey: () => "github.com/acme/app",
    }),
  };
});

import { SettingsProjectOverviewRouteScreen } from "./SettingsProjectOverviewRouteScreen";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.update.mockReset();
  mocks.update.mockResolvedValue({ _tag: "Success" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("renames the project in every environment while the filter shows one", async () => {
  await act(async () => root.render(<SettingsProjectOverviewRouteScreen />));
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "New name");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());

  expect(mocks.update.mock.calls.map(([call]) => call)).toEqual([
    { environmentId: "local", input: { projectId: "local-project", title: "New name" } },
    { environmentId: "remote", input: { projectId: "remote-project", title: "New name" } },
  ]);
});

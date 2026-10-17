// @vitest-environment jsdom
import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    updateSettings: vi.fn(),
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["local"]),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({ RUNTIME_MODE_CHOICES: [] }));
vi.mock("../../components/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/AppText", () => ({ AppText: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsChoiceRow", () => ({ SettingsChoiceRow: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/SettingsProjectOverridesSection", () => ({
  SettingsProjectOverridesSection: () => null,
}));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [
      {
        environmentId: "local",
        serverConfig: {
          settings: DEFAULT_SERVER_SETTINGS,
          environment: { capabilities: { projectSettingsOverrides: true } },
        },
      },
    ],
    projectGroups: [],
    selectedProjectKey: null,
  }),
}));

import { SettingsEnvironmentSourceControlRouteScreen } from "./SettingsServerControlsRouteScreen";

let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  mocks.updateSettings.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsServerControlsRouteScreen", () => {
  it("sends a draft saved during a pending write once that write settles", async () => {
    let settle = () => {};
    mocks.updateSettings.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    mocks.updateSettings.mockResolvedValue(undefined);
    act(() => root.render(<SettingsEnvironmentSourceControlRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    // The branch naming view closes with a draft while the mode write is pending.
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => settle());

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });
});

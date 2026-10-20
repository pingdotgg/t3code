import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@t3tools/contracts";
import { DEFAULT_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    updateSettings: vi.fn(),
    alert: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    projectSelected: false,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({}),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(mocks.targets.map((target) => target.environmentId)),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/vcs", () => ({ useVcsTerminology: () => DEFAULT_VCS_TERMINOLOGY }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({ RUNTIME_MODE_CHOICES: [] }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/DatabaseStorageNotice", () => ({ DatabaseStorageNotice: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsChoiceRow", () => ({ SettingsChoiceRow: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
    projectGroups: [
      {
        key: "project",
        label: "Project",
        members: mocks.targets.map((target) => ({
          project: { environmentId: target.environmentId, id: "project" },
        })),
      },
    ],
    selectedProjectKey: mocks.projectSelected ? "project" : null,
  }),
}));

import { SettingsEnvironmentSourceControlRouteScreen } from "./SettingsServerControlsRouteScreen";
import { SettingsThreadsRouteScreen } from "./SettingsThreadsRouteScreen";

function environment(environmentId: string, label: string) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultAutoPull: false,
        sidebarAutoSettleOnMerge: false,
      },
      environment: {
        capabilities: { projectSettingsOverrides: true, threadAutoSettlement: true },
      },
    },
  };
}

function button(label: string) {
  const result = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function expectFailures() {
  const messages = mocks.alert.mock.calls
    .map(([title, message]) => `${title}\n${message}`)
    .join("\n");
  expect.soft(messages).toMatch(/Alpha(?:(?!Beta)[\s\S])*Permission denied/);
  expect.soft(messages).toMatch(/Beta(?:(?!Alpha)[\s\S])*Disk full/);
  expect.soft(messages).not.toContain("Healthy");
}

function failTwoEnvironments() {
  mocks.targets = [
    environment("healthy", "Healthy"),
    environment("alpha", "Alpha"),
    environment("beta", "Beta"),
  ];
  mocks.updateSettings.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
    environmentId === "healthy"
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(
          Cause.fail(new Error(environmentId === "alpha" ? "Permission denied" : "Disk full")),
        ),
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.projectSelected = false;
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsServerControlsRouteScreen", () => {
  it("sends a draft saved during a pending write once that write settles", async () => {
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsEnvironmentSourceControlRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    // The branch naming view closes with a draft while the mode write is pending.
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });
});

describe.each([
  {
    name: "source control",
    Screen: SettingsEnvironmentSourceControlRouteScreen,
    label: "Automatically pull",
    key: "defaultAutoPull",
  },
  {
    name: "thread behavior",
    Screen: SettingsThreadsRouteScreen,
    label: "Auto-settle merged threads",
    key: "sidebarAutoSettleOnMerge",
  },
] as const)("$name shared settings", ({ Screen, label, key }) => {
  it("identifies each failed environment and reason, then allows a subscription-driven retry", async () => {
    failTwoEnvironments();
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<Screen />));

    act(() => button(label).click());
    expect(button(label).disabled).toBe(true);
    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expectFailures();
    expect(mocks.updateSettings.mock.calls.map(([input]) => input.environmentId)).toEqual([
      "healthy",
      "alpha",
      "beta",
    ]);
    expect(button(label).disabled).toBe(false);
    expect(button(label).getAttribute("aria-checked")).toBe("false");

    mocks.alert.mockClear();
    mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
    await act(async () => button(label).click());
    expect(mocks.updateSettings).toHaveBeenCalledTimes(6);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(button(label).getAttribute("aria-checked")).toBe("false");

    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, [key]: true },
      },
    }));
    act(() => root.render(<Screen />));
    expect(button(label).getAttribute("aria-checked")).toBe("true");
  });

  it("reports failed project resets and keeps overrides visible until a successful retry is received", async () => {
    failTwoEnvironments();
    mocks.projectSelected = true;
    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: {
          ...target.serverConfig.settings,
          projectSettingsOverrides: { project: { [key]: true } },
        },
      },
    }));
    act(() => root.render(<Screen />));

    await act(async () => button("Use defaults").click());

    expectFailures();
    expect(button(label).getAttribute("aria-checked")).toBe("true");
    expect(button("Use defaults").disabled).toBe(false);

    mocks.alert.mockClear();
    mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
    await act(async () => button("Use defaults").click());
    expect(mocks.updateSettings).toHaveBeenCalledTimes(6);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(button(label).getAttribute("aria-checked")).toBe("true");

    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        settings: { ...target.serverConfig.settings, projectSettingsOverrides: {} },
      },
    }));
    act(() => root.render(<Screen />));
    expect(button(label).getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).not.toContain("Use defaults");
  });

  it("does not alert for an interrupted write and releases the controls for retry", async () => {
    const pending = Promise.withResolvers<AsyncResult.Failure<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<Screen />));

    act(() => button(label).click());
    expect(button(label).disabled).toBe(true);
    await act(async () => pending.resolve(AsyncResult.failure(Cause.interrupt(1))));

    expect(mocks.alert).not.toHaveBeenCalled();
    expect(button(label).disabled).toBe(false);
    await act(async () => button(label).click());
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});

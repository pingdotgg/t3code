import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundConnectionStatus } from "../../native/backgroundConnection";

const native = vi.hoisted(() => ({
  status: null as BackgroundConnectionStatus | null,
  setEnabled: vi.fn(),
  requestExemption: vi.fn(),
  removeStatusListener: vi.fn(),
}));

const reactNative = vi.hoisted(() => ({
  alert: vi.fn(),
  removeAppStateListener: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (setup: () => void | (() => void)) => {
    setup();
  },
  useState: (initial: unknown) => [
    typeof initial === "function" ? (initial as () => unknown)() : initial,
    vi.fn(),
  ],
}));

vi.mock("react-native", () => ({
  Alert: { alert: reactNative.alert },
  AppState: {
    addEventListener: vi.fn(() => ({ remove: reactNative.removeAppStateListener })),
  },
  Platform: { OS: "android" },
  Pressable: "Pressable",
  View: "View",
}));

vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: "SettingsSection",
}));
vi.mock("../settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: "SettingsSwitchRow",
}));
vi.mock("../../native/backgroundConnection", () => ({
  addBackgroundConnectionStatusListener: vi.fn(() => ({
    remove: native.removeStatusListener,
  })),
  getBackgroundConnectionStatus: () => native.status,
  requestBackgroundConnectionBatteryOptimizationExemption: native.requestExemption,
  setBackgroundConnectionEnabled: native.setEnabled,
}));

import { BackgroundConnectionSettingsSection } from "./BackgroundConnectionSettingsSection";

interface ElementNode {
  readonly props?: {
    readonly children?: unknown;
    readonly onValueChange?: (enabled: boolean) => void;
  };
}

function children(node: unknown): ReadonlyArray<unknown> {
  const value = (node as ElementNode | null)?.props?.children;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function renderSwitch(): ElementNode {
  const root = BackgroundConnectionSettingsSection();
  const section = children(root)[0];
  return children(section)[0] as ElementNode;
}

function status(overrides: Partial<BackgroundConnectionStatus> = {}): BackgroundConnectionStatus {
  return {
    supported: true,
    enabled: false,
    serviceRunning: false,
    runtimeReady: false,
    batteryOptimizationIgnored: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.status = status();
  native.setEnabled.mockImplementation(async (enabled: boolean) =>
    status({
      enabled,
      serviceRunning: enabled,
      runtimeReady: enabled,
    }),
  );
  native.requestExemption.mockResolvedValue(status({ enabled: true }));
});

describe("BackgroundConnectionSettingsSection", () => {
  it("enables the native runtime and keeps it enabled when battery exemption is declined", async () => {
    native.setEnabled.mockResolvedValue(
      status({
        enabled: true,
        serviceRunning: true,
        runtimeReady: true,
        batteryOptimizationIgnored: false,
      }),
    );
    native.requestExemption.mockResolvedValue(
      status({ enabled: true, batteryOptimizationIgnored: false }),
    );

    renderSwitch().props?.onValueChange?.(true);

    await vi.waitFor(() => {
      expect(native.setEnabled).toHaveBeenCalledWith(true);
      expect(reactNative.alert).toHaveBeenCalledOnce();
    });
    const buttons = reactNative.alert.mock.calls[0]?.[2] as
      | ReadonlyArray<{ readonly text: string; readonly onPress?: () => void }>
      | undefined;
    buttons?.find((button) => button.text === "Allow")?.onPress?.();
    await vi.waitFor(() => expect(native.requestExemption).toHaveBeenCalledOnce());

    expect(native.setEnabled).not.toHaveBeenCalledWith(false);
  });

  it("disables the native runtime without requesting a battery exemption", async () => {
    native.status = status({
      enabled: true,
      serviceRunning: true,
      runtimeReady: true,
    });
    native.setEnabled.mockResolvedValue(status());

    renderSwitch().props?.onValueChange?.(false);

    await vi.waitFor(() => expect(native.setEnabled).toHaveBeenCalledWith(false));
    expect(reactNative.alert).not.toHaveBeenCalled();
    expect(native.requestExemption).not.toHaveBeenCalled();
  });
});

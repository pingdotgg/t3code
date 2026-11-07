import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type DevicePlatform,
  type DeviceServiceState,
} from "@t3tools/contracts";

const testPlatform: DevicePlatform =
  process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios";

const { Children, harness } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  harness: {
    state: null as DeviceServiceState | null,
    foreground: true,
    isDevice: true,
    hubAccessHosts: [] as string[],
    streamMounts: 0,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: Children,
  StatusBar: () => null,
  Platform: {
    OS: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios",
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: Children },
  FadeIn: { duration: () => ({ reduceMotion: () => ({}) }) },
  FadeOut: { duration: () => ({ reduceMotion: () => ({}) }) },
  ReduceMotion: { System: "system" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-sensors", () => ({
  Accelerometer: { setUpdateInterval: vi.fn(), addListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("expo-device", () => ({
  get isDevice() {
    return harness.isDevice;
  },
}));
vi.mock("@t3tools/client-runtime/state/device", () => ({
  deviceToolVersionLabels: () => [],
  deviceToolUpdateOwnership: "",
  deviceToolUpdatePolicy: () => "",
}));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetCloseButton: (props: { onClose: () => void; accessibilityLabel: string }) => (
    <button onClick={props.onClose}>{props.accessibilityLabel}</button>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Children }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/useBarInset", () => ({ useBarOverlap: () => 0 }));
vi.mock("../../components/ui/Menu", () => {
  type Action = { id: string; title: string; subactions?: Action[] };
  const flatten = (actions: Action[]): Action[] =>
    actions.flatMap((action) => [action, ...flatten(action.subactions ?? [])]);
  return {
    Menu: (props: {
      actions: Action[];
      onPressAction: (event: { nativeEvent: { event: string } }) => void;
    }) => (
      <>
        {flatten(props.actions).map((action) => (
          <button
            key={action.id}
            onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
          >
            {action.title}
          </button>
        ))}
      </>
    ),
  };
});
vi.mock("../../lib/appState", () => ({ useAppForeground: () => harness.foreground }));
vi.mock("../../lib/backHandler", () => ({ useHardwareBack: () => {} }));
vi.mock("../../lib/reserved-regions", () => ({
  deriveBottomControlInsets: () => ({ left: 0, right: 0 }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "viewer" }));
vi.mock("../../native/native-layout-metrics", () => ({
  useNativeColumnLayoutMetrics: () => null,
}));
vi.mock("../../state/device", () => ({
  deviceEnvironment: { list: {}, shutdown: {}, state: () => ({}) },
  useDeviceHubAccess: (_environmentId: string, hostId: string) => {
    harness.hubAccessHosts.push(hostId);
    return { access: { hostId }, error: null, refresh: vi.fn() };
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: harness.state, error: null, refresh: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("./DeviceStreamWebView", () => ({
  DeviceStreamWebView: (props: { deviceId: string }) => {
    useState(() => harness.streamMounts++);
    return <div data-stream={props.deviceId} />;
  },
}));

import { DevicePreviewScreen } from "./DevicePreviewRouteScreen";

const threadId = ThreadId.make("thread");
const host = (id: string) => ({
  id,
  kind: "local" as const,
  label: id,
  platforms: [],
  hubInstalled: true,
  agentDeviceInstalled: true,
});
const deviceState = (
  devices: ReadonlyArray<{ id: string; name: string; physical: boolean }>,
): DeviceServiceState => ({
  hosts: [host("local")],
  hostStatus: "ready",
  hostStatuses: {},
  devices: devices.map((device) => ({
    ...device,
    hostId: "local",
    platform: testPlatform,
    version: "",
    booted: true,
  })),
  sessions: devices.map((device) => ({
    threadId,
    hostId: "local",
    deviceId: device.id,
    platform: testPlatform,
    openedAt: "2026-11-08T00:00:00Z",
  })),
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
});
const pixel = { id: "pixel-serial", name: "Pixel 7", physical: true };
const tablet = { id: "tablet-serial", name: "Pixel Tablet", physical: true };
const emulator = { id: "emulator-5554", name: "Emulator", physical: false };

function setup(state: DeviceServiceState, isDevice = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.state = state;
  harness.foreground = true;
  harness.isDevice = isDevice;
  harness.hubAccessHosts.length = 0;
  harness.streamMounts = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (environmentId = "environment") =>
    act(() =>
      root.render(
        <DevicePreviewScreen
          environmentId={EnvironmentId.make(environmentId)}
          threadId={threadId}
          onClose={vi.fn()}
        />,
      ),
    );
  const press = (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!button) throw new Error(`No ${label} button`);
    act(() => button.click());
  };
  render();
  return {
    container,
    render,
    press,
    streaming: () => container.querySelector("[data-stream]")?.getAttribute("data-stream") ?? null,
    warned: () => container.textContent?.includes("can freeze T3 Code") ?? false,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("holds back a stream that could be this device until the user continues for that device", () => {
  using screen = setup(deviceState([pixel, tablet]));
  expect(screen.warned()).toBe(true);
  expect(screen.streaming()).toBeNull();
  expect(harness.hubAccessHosts).toEqual([]);

  screen.press("Continue");
  expect(screen.streaming()).toBe(pixel.id);

  screen.press(tablet.name);
  expect(screen.streaming()).toBeNull();
  expect(screen.warned()).toBe(true);
  screen.press("Continue");
  expect(screen.streaming()).toBe(tablet.id);

  screen.press("Reload stream");
  expect(screen.streaming()).toBeNull();
  screen.press("Continue");

  harness.foreground = false;
  screen.render();
  expect(screen.streaming()).toBeNull();
  harness.foreground = true;
  screen.render();
  expect(screen.streaming()).toBeNull();
  expect(screen.warned()).toBe(true);
  screen.press("Continue");

  screen.render("other-environment");
  expect(screen.streaming()).toBeNull();
  screen.press("Continue");

  // The selected tablet's session ended, so the screen falls back to the pixel.
  harness.state = deviceState([pixel]);
  screen.render("other-environment");
  expect(screen.streaming()).toBeNull();
  expect(screen.warned()).toBe(true);
});

it("streams an emulator directly unless this app runs in one", () => {
  {
    using screen = setup(deviceState([emulator]));
    expect(screen.warned()).toBe(false);
    expect(screen.streaming()).toBe(emulator.id);
  }
  using screen = setup(deviceState([emulator]), false);
  expect(screen.warned()).toBe(true);
  expect(screen.streaming()).toBeNull();
  expect(harness.hubAccessHosts).toEqual([]);
});

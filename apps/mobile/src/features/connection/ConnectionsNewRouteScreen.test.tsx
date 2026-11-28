import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Children, harness } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  harness: {
    // The app-wide error slot other features (composer sends, branch refreshes) write to.
    pendingConnectionError: null as string | null,
    connectPress: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: Children,
  Linking: { openSettings: vi.fn() },
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({
  default: Children,
  Defs: Children,
  RadialGradient: Children,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useIsFocused: () => true,
  useNavigation: () => ({ canGoBack: () => true, goBack: vi.fn(), dispatch: vi.fn() }),
  useRoute: () => ({ name: "ConnectionsNew" }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isLoaded: false, isSignedIn: false }) }));
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, vi.fn()],
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    onEndEditing,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    onEndEditing?: () => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.currentTarget.value)}
      onBlur={onEndEditing}
    />
  ),
}));
vi.mock("../../components/ui/FrostedCutout", () => ({ FrostedCutout: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({
    children,
    actions,
  }: {
    children: ReactNode;
    actions: { accessibilityLabel: string; disabled: boolean; onPress: () => void }[];
  }) => (
    <>
      {children}
      {actions.map(({ accessibilityLabel, disabled, onPress }) => (
        <button key={accessibilityLabel} disabled={disabled} onClick={onPress}>
          {accessibilityLabel}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../settings/settings-navigation", () => ({
  leaveSettingsPage: vi.fn(),
  openSettings: vi.fn(),
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => false,
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./CloudEnvironmentRows", () => ({ CloudEnvironmentRows: () => null }));
vi.mock("./environmentSections", () => ({
  splitEnvironmentSections: () => ({ connectedCloudEnvironments: [] }),
}));
vi.mock("./devAutoConnect", () => ({
  autoConnectReport: () => ({ connecting: false, error: null }),
  devAutoConnectAttemptAtom: {},
  pairingLinksAllowed: () => __DEV__,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  setPendingConnectionError: (message: string | null) => {
    harness.pendingConnectionError = message;
  },
  useRemoteConnections: () => ({
    connectionPairingUrl: "",
    connectedEnvironments: [],
    pairingConnectionError: harness.pendingConnectionError,
    onChangeConnectionPairingUrl: vi.fn(),
    onConnectPress: harness.connectPress,
    onSetEnvironmentEnabled: vi.fn(),
    onRemoveEnvironmentPress: vi.fn(),
  }),
}));

import { ConnectionsNewRouteScreen } from "./ConnectionsNewRouteScreen";

function enter(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("does not show another feature's error as a pairing failure", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = "Could not send the message.";
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));

  expect(container.textContent).not.toContain("Could not send the message.");
  expect(container.textContent).toContain("For machines on your local network or tailnet.");

  act(() => root.unmount());
  // Leaving the form must not wipe an error that belongs to another screen.
  expect(harness.pendingConnectionError).toBe("Could not send the message.");
});

it("splits a pasted pairing link when editing ends and preserves the code during address edits", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = null;
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));
    const address = container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
    const code = container.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;

    enter(code, "manual-code");
    const pasted = "  http://100.82.53.91:3773/pair#token=test-pairing-code";
    enter(address, pasted);
    expect(address.value).toBe(pasted);
    expect(code.value).toBe("manual-code");
    act(() => address.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(address.value).toBe("http://100.82.53.91:3773");
    expect(code.value).toBe("test-pairing-code");

    enter(code, "replacement-code");
    for (const value of ["", "100.82.53.92:3773", "http://100.82.53.92:3773/"]) {
      enter(address, value);
      expect(address.value).toBe(value);
      expect(code.value).toBe("replacement-code");
    }
  } finally {
    act(() => root.unmount());
  }
});

it("keeps a typed pairing link intact and submits its full token", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("__DEV__", false);
  harness.pendingConnectionError = null;
  harness.connectPress.mockReset().mockResolvedValue({ ok: false, error: null });
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<ConnectionsNewRouteScreen route={{ params: undefined }} />));
    const address = container.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
    const url = "http://100.82.53.91:3773/pair#token=test-pairing-code";
    for (const character of url) enter(address, address.value + character);
    expect(address.value).toBe(url);

    await act(async () => container.querySelector("button")!.click());
    expect(harness.connectPress).toHaveBeenCalledWith(
      "http://100.82.53.91:3773/#token=test-pairing-code",
      undefined,
    );
  } finally {
    act(() => root.unmount());
  }
});

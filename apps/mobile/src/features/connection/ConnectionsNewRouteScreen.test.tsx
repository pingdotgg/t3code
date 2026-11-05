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
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/FrostedCutout", () => ({ FrostedCutout: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/settings-navigation", () => ({
  leaveSettingsPage: vi.fn(),
  openSettings: vi.fn(),
}));
vi.mock("../workspace/workspace-selection-store", () => ({ workspaceHasColumns: () => false }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./CloudEnvironmentRows", () => ({ CloudEnvironmentRows: () => null }));
vi.mock("./environmentSections", () => ({
  splitEnvironmentSections: () => ({ connectedCloudEnvironments: [] }),
}));
vi.mock("./devAutoConnect", () => ({
  autoConnectReport: () => ({ connecting: false, error: null }),
  devAutoConnectAttemptAtom: {},
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

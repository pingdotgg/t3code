import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  vi.stubGlobal("__DEV__", true);
  return { pair: vi.fn() };
});

// The native package pulls in React Native; its link parsing and actions live in core and routers.
vi.mock("@react-navigation/native", () => {
  const requireFromNative = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  const requireFromCore = NodeModule.createRequire(
    requireFromNative.resolve("@react-navigation/core/package.json"),
  );
  const { getStateFromPath } = requireFromNative("@react-navigation/core");
  const { CommonActions, StackActions } = requireFromCore("@react-navigation/routers");
  return { getStateFromPath, CommonActions, StackActions };
});

vi.mock("./rootNavigation", () => ({
  rootNavigationRef: { isReady: () => false },
  whenRootNavigationReady: () => {},
}));
vi.mock("../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("../features/prompt-links/prompt-link-actions", () => ({}));
// Stores the prompt-link steps read only when a link carries a prompt; they load the native runtime.
vi.mock("../state/projects", () => ({}));
vi.mock("../state/pull-requests", () => ({}));
vi.mock("../state/server", () => ({}));
vi.mock("../state/threads", () => ({}));
vi.mock("../state/use-composer-drafts", () => ({}));
vi.mock("../state/workspace", () => ({}));
vi.mock("../state/use-remote-environment-registry", () => ({ pairEnvironment: harness.pair }));
vi.mock("../features/workspace/workspace-selection-store", () => ({
  settingsLinkPage: () => undefined,
  workspaceHasColumns: () => false,
}));

import { findLinkedRoute } from "./appLinking";
import { getAppStateFromPath } from "./appLinkState";

const PAIRING_URL = "http://192.168.1.10:3773/pair#token=abc";

// RootStack imports every screen, which Node cannot load; these are its paths for the pairing form.
const linking = {
  initialRouteName: "Home",
  screens: {
    Home: "",
    Settings: "settings",
    SettingsEnvironmentNew: "settings/environment-new",
    ConnectionsNew: "connections/new",
  },
};

it("a link cannot aim a pairing at a saved environment", () => {
  harness.pair.mockResolvedValue({ ok: false, error: null });
  for (const path of ["connections/new", "settings/environment-new"]) {
    harness.pair.mockClear();
    const state = getAppStateFromPath(
      `${path}?routeFor=victim&pairingUrl=${encodeURIComponent(PAIRING_URL)}&autoConnect=1`,
      linking,
    );

    expect(findLinkedRoute(state, ["ConnectionsNew", "SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: PAIRING_URL,
      autoConnect: "1",
    });
    expect(harness.pair).toHaveBeenCalledExactlyOnceWith(PAIRING_URL);
  }
});

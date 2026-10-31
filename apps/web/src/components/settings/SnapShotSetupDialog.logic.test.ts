import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  captureSetupAccessReady,
  captureSetupBackend,
  captureSetupCheckMessage,
  captureSetupDesktopName,
  captureSetupInitialStep,
  captureSetupMacPermissionsReady,
  captureSetupShortcutReady,
  captureSetupShouldDisableOnClose,
} from "./SnapShotSetupDialog.logic";

const gnome: DesktopSnapShotState = {
  mode: "portal",
  linuxBackend: "gnome-extension",
  shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
  shortcutRegistered: true,
  shortcutMessage: "Requested",
  shortcutVerified: false,
  message: null,
  gnomeExtension: { status: "enabled", message: "Running" },
};

it("derives Hyprland setup from its own helper and registered action, not old GNOME approval", () => {
  const state: DesktopSnapShotState = {
    ...gnome,
    linuxBackend: "hyprland",
    linuxDesktop: "hyprland",
    shortcutRegistered: false,
    hyprlandHelper: { status: "not-installed", message: "Install" },
  };
  expect(captureSetupBackend(state)).toBe("hyprland");
  expect(captureSetupDesktopName(state)).toBe("Hyprland");
  expect(captureSetupAccessReady(state)).toBe(false);
  expect(captureSetupInitialStep(state)).toBe("access");
  const installed = { ...state, hyprlandHelper: { status: "ready" as const, message: "Ready" } };
  expect(captureSetupInitialStep(installed)).toBe("shortcut");
  expect(captureSetupShortcutReady(installed, false)).toBe(false);
  expect(captureSetupShortcutReady({ ...installed, shortcutPending: true }, false)).toBe(false);
  expect(captureSetupShortcutReady({ ...installed, shortcutActionRegistered: true }, false)).toBe(
    true,
  );
  expect(captureSetupAccessReady({ ...installed, message: "Check access" })).toBe(false);
});

it.each(["disabled", "error"] as const)(
  "keeps %s GNOME setup on the access step, even with a previously verified shortcut",
  (status) => {
    const state = {
      ...gnome,
      shortcutVerified: true,
      gnomeExtension: { status, message: "Needs setup" },
    };
    expect(captureSetupInitialStep(state)).toBe("access");
    expect(captureSetupInitialStep(state, "shortcut")).toBe("access");
    expect(captureSetupAccessReady(state)).toBe(false);
    expect(captureSetupShortcutReady(state, false)).toBe(false);
  },
);

it("does not declare access ready before the enabled extension's capture endpoint is available", () => {
  expect(captureSetupAccessReady({ ...gnome, linuxBackend: "picker" })).toBe(false);
  expect(captureSetupAccessReady(gnome)).toBe(true);
});

it("resumes after login from real extension state without an onboarding-completed flag", () => {
  expect(
    captureSetupInitialStep({
      ...gnome,
      gnomeExtension: { status: "disabled", message: "Enable it" },
    }),
  ).toBe("access");
  expect(captureSetupInitialStep({ ...gnome, shortcutRegistered: false })).toBe("shortcut");
  expect(captureSetupInitialStep(gnome)).toBe("shortcut");
});

it("does not skip native permission setup when capture has not been enabled", () => {
  expect(
    captureSetupInitialStep({
      ...gnome,
      mode: "direct",
      linuxBackend: undefined,
      gnomeExtension: undefined,
      shortcutRegistered: false,
    }),
  ).toBe("access");
});

it("offers manual capture on an unsupported GNOME version instead of trapping setup", () => {
  const state = {
    ...gnome,
    linuxBackend: "picker" as const,
    gnomeExtension: { status: "unsupported" as const, message: "New GNOME version" },
  };
  expect(captureSetupBackend(state)).toBe("picker");
  expect(captureSetupAccessReady(state)).toBe(true);
  expect(captureSetupInitialStep(state)).toBe("access");
  expect(captureSetupCheckMessage(state)).toContain("choose a window each time");
});

it.each(["not-installed", "error"] as const)(
  "requires KDE helper access for %s even with a saved shortcut",
  (status) => {
    const state = {
      ...gnome,
      linuxBackend: "kde" as const,
      gnomeExtension: undefined,
      kdeHelper: { status, message: "Needs setup" },
      shortcutVerified: true,
    };
    expect(captureSetupBackend(state)).toBe("kde");
    expect(captureSetupAccessReady(state)).toBe(false);
    expect(captureSetupInitialStep(state, "shortcut")).toBe("access");
    expect(captureSetupShortcutReady(state, false)).toBe(false);
  },
);

it("resumes KDE setup after the helper passes its real permission check", () => {
  const state = {
    ...gnome,
    linuxBackend: "kde" as const,
    gnomeExtension: undefined,
    kdeHelper: { status: "ready" as const, message: "Ready" },
  };
  expect(captureSetupAccessReady(state)).toBe(true);
  expect(captureSetupInitialStep(state)).toBe("shortcut");
  expect(captureSetupInitialStep({ ...state, shortcutRegistered: false })).toBe("shortcut");
});

it("does not report a successful check when capture support could not be read", () => {
  expect(captureSetupCheckMessage({ ...gnome, message: "Desktop disconnected" })).toContain(
    "Still unable to check access",
  );
  expect(
    captureSetupCheckMessage({
      ...gnome,
      gnomeExtension: { status: "error", message: "Could not read extension state" },
    }),
  ).toContain("Still unable to check access");
});

it("uses a capable portal without requiring the optional GNOME extension", () => {
  const state = {
    ...gnome,
    linuxBackend: "screenshot-portal" as const,
    gnomeExtension: { status: "not-installed" as const, message: "Not installed" },
  };
  expect(captureSetupBackend(state)).toBe("portal");
  expect(captureSetupAccessReady(state)).toBe(true);
  expect(captureSetupInitialStep(state)).toBe("shortcut");
  expect(
    captureSetupCheckMessage({
      ...state,
      gnomeExtension: { status: "error", message: "Optional extension failed" },
    }),
  ).toBe("Ready. Continue to choose your shortcut.");
});

it("lets Niri setup finish with configuration instructions without claiming the binding was verified", () => {
  const niri = {
    ...gnome,
    linuxBackend: "niri" as const,
    gnomeExtension: undefined,
    shortcutRegistered: false,
  };
  expect(captureSetupBackend(niri)).toBe("niri");
  expect(captureSetupAccessReady(niri)).toBe(true);
  expect(captureSetupShortcutReady(niri, false)).toBe(false);
  const withEndpoint = { ...niri, shortcutBinding: "Ctrl+Shift+2 { spawn ...; }" };
  expect(captureSetupInitialStep(withEndpoint)).toBe("shortcut");
  expect(captureSetupShortcutReady(withEndpoint, false)).toBe(true);
  expect(withEndpoint.shortcutRegistered).toBe(false);
  expect(withEndpoint.shortcutVerified).toBe(false);
});

it("requires saving a changed chord before finishing setup", () => {
  expect(captureSetupShortcutReady(gnome, true)).toBe(false);
  expect(captureSetupShortcutReady(gnome, false)).toBe(true);
  expect(captureSetupShortcutReady({ ...gnome, shortcutRegistered: false }, false)).toBe(false);
});

it("allows leaving setup while the desktop prompt is pending but never after an explicit denial", () => {
  const pending = { ...gnome, shortcutRegistered: false, shortcutPending: true };
  expect(captureSetupShortcutReady(pending, false)).toBe(true);
  expect(captureSetupShortcutReady(pending, true)).toBe(false);
  expect(captureSetupShortcutReady({ ...pending, shortcutPending: false }, false)).toBe(false);
});

it("blocks finishing if desktop access is lost during the wizard", () => {
  expect(
    captureSetupShortcutReady(
      {
        ...gnome,
        shortcutVerified: true,
        message: "Desktop disconnected",
      },
      false,
    ),
  ).toBe(false);
  expect(captureSetupAccessReady({ ...gnome, mode: "unavailable" })).toBe(false);
});

it.each([
  [false, false, true],
  [true, false, false],
] as const)(
  "closing setup (previously enabled=%s, completed=%s) disables only an unfinished first opt-in",
  (wasEnabled, completed, disable) => {
    expect(captureSetupShouldDisableOnClose(wasEnabled, completed)).toBe(disable);
  },
);

it("gates Continue on macOS permissions, requiring accessibility only when app text is on", () => {
  const mac: DesktopSnapShotState = {
    ...gnome,
    mode: "direct",
    linuxBackend: undefined,
    gnomeExtension: undefined,
    macPermissions: { screenRecording: true, accessibility: false },
  };
  expect(captureSetupMacPermissionsReady(mac, true)).toBe(false);
  expect(captureSetupMacPermissionsReady(mac, false)).toBe(true);
  expect(
    captureSetupMacPermissionsReady(
      { ...mac, macPermissions: { screenRecording: false, accessibility: true } },
      false,
    ),
  ).toBe(false);
  expect(captureSetupMacPermissionsReady({ ...mac, macPermissions: undefined }, true)).toBe(true);
});

it.each(["kde", "hyprland"] as const)("ignores errors from inactive helpers on %s", (backend) => {
  const state: DesktopSnapShotState = {
    ...gnome,
    linuxBackend: backend,
    kdeHelper: { status: backend === "kde" ? "ready" : "error", message: "KDE" },
    hyprlandHelper: { status: backend === "hyprland" ? "ready" : "error", message: "Hyprland" },
  };
  expect(captureSetupAccessReady(state)).toBe(true);
  expect(captureSetupCheckMessage(state)).toBe("Ready. Continue to choose your shortcut.");
});

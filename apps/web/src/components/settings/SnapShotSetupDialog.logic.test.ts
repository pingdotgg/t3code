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

it.each([
  "not-installed",
  "disabled",
  "restart-required",
  "update-required",
  "extensions-disabled",
  "error",
] as const)(
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

it("finishes setup with a saved shortcut without requiring a separate delivery test", () => {
  expect(captureSetupInitialStep({ ...gnome, shortcutVerified: false })).toBe("shortcut");
  expect(captureSetupShortcutReady(gnome, false)).toBe(true);
});

it("still allows revisiting capture access and editing a saved shortcut", () => {
  expect(captureSetupInitialStep(gnome, "access")).toBe("access");
  expect(captureSetupInitialStep(gnome, "shortcut")).toBe("shortcut");
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

it("keeps the picker explanation when automatic capture is unavailable", () => {
  expect(
    captureSetupInitialStep({ ...gnome, linuxBackend: "picker", gnomeExtension: undefined }),
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

it.each(["not-installed", "update-required", "error"] as const)(
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

it("uses the current desktop's access requirements while preserving setup for the others", () => {
  const kde: DesktopSnapShotState = {
    ...gnome,
    linuxDesktop: "kde",
    linuxBackend: "kde",
    kdeHelper: { status: "not-installed", message: "Install the helper" },
    shortcutVerified: false,
  };
  expect(captureSetupDesktopName(kde)).toBe("KDE Plasma");
  expect(captureSetupInitialStep(kde)).toBe("access");
  expect(
    captureSetupInitialStep({
      ...kde,
      kdeHelper: { status: "ready", message: "Ready" },
      shortcutRegistered: false,
    }),
  ).toBe("shortcut");

  const niri: DesktopSnapShotState = {
    ...gnome,
    linuxDesktop: "niri",
    linuxBackend: "niri",
    shortcutRegistered: false,
  };
  expect(captureSetupDesktopName(niri)).toBe("Niri");
  expect(captureSetupInitialStep(niri)).toBe("shortcut");

  expect(captureSetupDesktopName(gnome)).toBe("GNOME");
  expect(captureSetupInitialStep(gnome)).toBe("shortcut");
  expect(captureSetupShortcutReady(gnome, false)).toBe(true);
});

it("does not infer a Linux desktop for native capture or an unidentified portal", () => {
  expect(captureSetupDesktopName({ ...gnome, mode: "direct" })).toBeUndefined();
  expect(
    captureSetupDesktopName({
      ...gnome,
      linuxBackend: "screenshot-portal",
      gnomeExtension: undefined,
    }),
  ).toBeUndefined();
});

it("acknowledges an unchanged recheck while GNOME still needs a sign-out", () => {
  const state = {
    ...gnome,
    gnomeExtension: { status: "restart-required" as const, message: "Sign out" },
  };
  expect(captureSetupCheckMessage(state)).toBe("Still waiting for you to sign out and back in.");
  expect(captureSetupAccessReady(state)).toBe(false);
});

it("only confirms capture access when the rechecked extension is running and reachable", () => {
  expect(captureSetupCheckMessage(gnome)).toBe("Ready. Continue to choose your shortcut.");
  expect(captureSetupCheckMessage({ ...gnome, linuxBackend: "picker" })).toBe(
    "Not ready yet. Finish the step above.",
  );
  expect(
    captureSetupCheckMessage({
      ...gnome,
      gnomeExtension: { status: "disabled", message: "Enable it" },
    }),
  ).toBe("Not ready yet. Finish the step above.");
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

it.each([false, true])(
  "does not require a previously observed shortcut activation (%s)",
  (shortcutVerified) => {
    const state = { ...gnome, shortcutVerified };
    expect(captureSetupShortcutReady(state, false)).toBe(true);
    expect(captureSetupInitialStep(state)).toBe("shortcut");
  },
);

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
  [false, true, false],
  [true, false, false],
  [true, true, false],
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

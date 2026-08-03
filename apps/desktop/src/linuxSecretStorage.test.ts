import { describe, expect, it } from "vite-plus/test";

import {
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  resolveLinuxSecretStorageUnavailableMessage,
} from "./linuxSecretStorage.ts";

const autoSwitch = (env: NodeJS.ProcessEnv) =>
  resolveLinuxPasswordStoreSwitch({ preference: "auto", env });

describe("linuxSecretStorage", () => {
  it("preserves explicit supported password-store preferences", () => {
    expect(normalizeLinuxPasswordStorePreference("gnome-libsecret")).toBe("gnome-libsecret");
    expect(normalizeLinuxPasswordStorePreference("kwallet")).toBe("kwallet");
    expect(normalizeLinuxPasswordStorePreference("kwallet5")).toBe("kwallet5");
    expect(normalizeLinuxPasswordStorePreference("kwallet6")).toBe("kwallet6");
  });

  it("falls back to auto for missing or unsupported preferences", () => {
    expect(normalizeLinuxPasswordStorePreference(undefined)).toBe("auto");
    expect(normalizeLinuxPasswordStorePreference("basic")).toBe("auto");
  });

  it("uses explicit preferences instead of the auto heuristic", () => {
    for (const preference of ["gnome-libsecret", "kwallet", "kwallet5", "kwallet6"] as const) {
      expect(
        resolveLinuxPasswordStoreSwitch({ preference, env: { XDG_CURRENT_DESKTOP: "niri" } }),
      ).toBe(preference);
      // An explicit preference also wins where auto would have stayed out of the way.
      expect(
        resolveLinuxPasswordStoreSwitch({ preference, env: { XDG_CURRENT_DESKTOP: "KDE" } }),
      ).toBe(preference);
    }
  });

  it("leaves canonical KDE sessions to Electron's own wallet selection", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "5" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "KDE:plasma" })).toBeNull();
  });

  it("does not force a password-store for desktops Electron already recognizes", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "GNOME" })).toBeNull();
    for (const desktop of ["Deepin", "Pantheon", "UKUI", "Unity", "X-Cinnamon", "XFCE"]) {
      expect(autoSwitch({ XDG_CURRENT_DESKTOP: desktop })).toBeNull();
    }
  });

  it("recognizes a known desktop later in a colon-separated XDG_CURRENT_DESKTOP list", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri:GNOME" })).toBeNull();
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBeNull();
  });

  it("forces gnome-libsecret for unrecognized Linux desktop sessions", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe("gnome-libsecret");
    expect(autoSwitch({})).toBe("gnome-libsecret");
  });

  it("forces gnome-libsecret for desktops Electron recognizes but leaves on basic text", () => {
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt" })).toBe("gnome-libsecret");
    // Chromium stops at the first recognized value, so a later name cannot rescue the session.
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:GNOME" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:KDE" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "LXQt:plasma" })).toBe("gnome-libsecret");
  });

  it("does not treat lowercase desktop names as ones Electron recognizes", () => {
    // Chromium matches these case-sensitively, so lowercase spellings reach basic text.
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "gnome" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "xfce" })).toBe("gnome-libsecret");
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "kde", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
  });

  it("overrides KDE sessions identified only by legacy variables", () => {
    // Chromium reaches KWallet4 for some of these, such as DESKTOP_SESSION=kde with a version, and
    // basic text for the rest. Either way these are the variables a previous session leaves behind,
    // so they are treated as unproven and forced to a real keyring rather than a guessed wallet.
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "plasma" })).toBe("gnome-libsecret");
    for (const session of [
      "kde",
      "kde-plasma",
      "kde4",
      "plasma",
      "plasmawayland",
      "plasmawayland-dev",
      "plasmax11",
      "plasmax11-dev",
    ]) {
      expect(autoSwitch({ DESKTOP_SESSION: session })).toBe("gnome-libsecret");
      expect(autoSwitch({ XDG_SESSION_DESKTOP: session })).toBe("gnome-libsecret");
      expect(autoSwitch({ GDMSESSION: session })).toBe("gnome-libsecret");
    }
    expect(autoSwitch({ DESKTOP_SESSION: "kde", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ KDE_SESSION_VERSION: "6" })).toBe("gnome-libsecret");
    expect(autoSwitch({ KDE_FULL_SESSION: "true", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
  });

  it("ignores stale session hints when XDG_CURRENT_DESKTOP is authoritative", () => {
    expect(
      autoSwitch({ XDG_CURRENT_DESKTOP: "niri", DESKTOP_SESSION: "gnome", GDMSESSION: "gnome" }),
    ).toBe("gnome-libsecret");
    // A previous KDE session left these behind; the compositor running now is not KDE.
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri", KDE_SESSION_VERSION: "6" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri", XDG_SESSION_DESKTOP: "GNOME" })).toBe(
      "gnome-libsecret",
    );
    expect(autoSwitch({ XDG_CURRENT_DESKTOP: "niri:plasma" })).toBe("gnome-libsecret");
    expect(
      autoSwitch({
        XDG_CURRENT_DESKTOP: "Hyprland",
        XDG_SESSION_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      }),
    ).toBe("gnome-libsecret");
  });

  it("uses GNOME Keyring remediation for libsecret and unknown backends", () => {
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "gnome_libsecret",
        env: { XDG_CURRENT_DESKTOP: "niri" },
      }),
    ).toContain("GNOME Keyring");
  });

  it("prefers explicit libsecret selection over KDE desktop heuristics", () => {
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "gnome-libsecret",
        selectedBackend: "unknown",
        env: { XDG_CURRENT_DESKTOP: "KDE" },
      }),
    ).toContain("GNOME Keyring");
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "gnome_libsecret",
        env: { XDG_CURRENT_DESKTOP: "KDE" },
      }),
    ).toContain("GNOME Keyring");
  });

  it("prefers explicit KWallet preference over selected gnome-libsecret backend", () => {
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "kwallet6",
        selectedBackend: "gnome_libsecret",
        env: { XDG_CURRENT_DESKTOP: "niri" },
      }),
    ).toContain("KWallet");
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "kwallet",
        selectedBackend: "gnome-libsecret",
        env: {},
      }),
    ).toContain("KWallet");
  });

  it("uses KWallet remediation wording for KDE-looking sessions", () => {
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "kwallet6",
        env: {},
      }),
    ).toContain("KWallet");
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "unknown",
        env: { XDG_CURRENT_DESKTOP: "KDE" },
      }),
    ).toContain("KWallet");
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "unknown",
        env: { DESKTOP_SESSION: "plasmawayland" },
      }),
    ).toContain("KWallet");
    // A desktop name outranks a bare KDE marker when choosing the wording.
    expect(
      resolveLinuxSecretStorageUnavailableMessage({
        configuredPreference: "auto",
        selectedBackend: "unknown",
        env: { GDMSESSION: "gnome", KDE_FULL_SESSION: "true" },
      }),
    ).toContain("GNOME Keyring");
  });
});

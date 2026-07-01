import { describe, expect, it } from "vite-plus/test";

import {
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  resolveLinuxSecretStorageUnavailableMessage,
} from "./linuxSecretStorage.ts";

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

  it("does not force a password-store for desktops Electron already recognizes", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_CURRENT_DESKTOP: "GNOME" },
      }),
    ).toBeNull();
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" },
      }),
    ).toBeNull();
  });

  it("uses KWallet for unversioned KDE sessions Electron may not recognize", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_CURRENT_DESKTOP: "KDE" },
      }),
    ).toBe("kwallet");
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { DESKTOP_SESSION: "plasma" },
      }),
    ).toBe("kwallet");
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_SESSION_DESKTOP: "plasma" },
      }),
    ).toBe("kwallet");
  });

  it("forces gnome-libsecret for unrecognized Linux desktop sessions", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_CURRENT_DESKTOP: "niri" },
      }),
    ).toBe("gnome-libsecret");
  });

  it("ignores stale legacy desktop hints when XDG_CURRENT_DESKTOP is authoritative", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: {
          XDG_CURRENT_DESKTOP: "niri",
          DESKTOP_SESSION: "gnome",
          GDMSESSION: "gnome",
        },
      }),
    ).toBe("gnome-libsecret");
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: {
          XDG_CURRENT_DESKTOP: "Hyprland",
          DESKTOP_SESSION: "gnome",
        },
      }),
    ).toBe("gnome-libsecret");
  });

  it("uses explicit preferences instead of the auto heuristic", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "kwallet6",
        env: { XDG_CURRENT_DESKTOP: "niri" },
      }),
    ).toBe("kwallet6");
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

  it("uses KWallet remediation for KDE desktops and selected backends", () => {
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
  });
});

import { describe, expect, it } from "vitest";

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

  it("forces gnome-libsecret for unrecognized Linux desktop sessions", () => {
    expect(
      resolveLinuxPasswordStoreSwitch({
        preference: "auto",
        env: { XDG_CURRENT_DESKTOP: "niri" },
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

// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
} from "./DesktopEarlyElectronStartup.ts";

describe("DesktopEarlyElectronStartup", () => {
  const joinPath = NodePath.posix.join;

  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("accepts JSONC in the early desktop settings file", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: () => `{
        // manually edited setting
        "linuxPasswordStore": "gnome-libsecret",
      }`,
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("falls back to auto when the early settings document is missing or invalid", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      readFileString: () => {
        throw new Error("missing");
      },
    });

    assert.equal(preference, "auto");
  });

  it("preserves absolute root paths when resolving early settings", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
    });

    assert.deepEqual(options, {
      isDevelopment: true,
      linuxWmClass: "t3code-dev",
      linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
      passwordStore: "gnome-libsecret",
    });
  });

  it("selects the configured keyring for gamescope before Electron starts", () => {
    const options = (input: {
      kwallet: boolean;
      gnome: boolean;
      wallet: boolean;
      desktop?: string;
      gnomeControl?: string;
      preference?: string;
    }) =>
      resolveEarlyLinuxElectronOptions({
        env: {
          XDG_CURRENT_DESKTOP: input.desktop ?? "gamescope",
          XDG_DATA_DIRS: "/usr/share",
          GNOME_KEYRING_CONTROL: input.gnomeControl,
        },
        homeDirectory: "/home/user",
        joinPath,
        readFileString: (path) => {
          if (path.endsWith("desktop-settings.json")) {
            return JSON.stringify({ linuxPasswordStore: input.preference ?? "auto" });
          }
          if (path === "/usr/share/dbus-1/services/org.kde.kwalletd6.service" && input.kwallet) {
            return "[D-BUS Service]\nName=org.kde.kwalletd6\n";
          }
          if (
            path === "/usr/share/dbus-1/services/org.freedesktop.secrets.service" &&
            input.gnome
          ) {
            return "[D-BUS Service]\nName=org.freedesktop.secrets\n";
          }
          throw new Error("service not installed");
        },
        fileExists: (path) => {
          assert.equal(path, "/home/user/.local/share/kwalletd/kdewallet.kwl");
          return input.wallet;
        },
      }).passwordStore;

    assert.equal(options({ kwallet: true, gnome: false, wallet: false }), "kwallet6");
    assert.equal(
      options({ kwallet: true, gnome: false, wallet: false, desktop: "gamescope:niri" }),
      "kwallet6",
    );
    assert.equal(options({ kwallet: false, gnome: true, wallet: false }), "gnome-libsecret");
    assert.equal(options({ kwallet: true, gnome: true, wallet: false }), "gnome-libsecret");
    assert.equal(options({ kwallet: true, gnome: true, wallet: true }), "kwallet6");
    assert.equal(
      options({ kwallet: true, gnome: true, wallet: true, gnomeControl: "/run/keyring" }),
      "gnome-libsecret",
    );
    assert.equal(
      options({ kwallet: true, gnome: false, wallet: true, preference: "gnome-libsecret" }),
      "gnome-libsecret",
    );
  });

  it("ignores relative XDG data paths when probing gamescope keyrings", () => {
    const readFileString = (path: string) => {
      if (path.endsWith("desktop-settings.json")) {
        throw new Error("no saved preference");
      }
      if (path === "/usr/share/dbus-1/services/org.kde.kwalletd6.service") {
        return "[D-BUS Service]\nName=org.kde.kwalletd6\n";
      }
      if (path === "/usr/share/dbus-1/services/org.freedesktop.secrets.service") {
        return "[D-BUS Service]\nName=org.freedesktop.secrets\n";
      }
      if (path === "relative/dbus-1/services/org.kde.kwalletd6.service") {
        return "[D-BUS Service]\nName=org.kde.kwalletd6\n";
      }
      throw new Error("service not installed");
    };
    const fallbackHome = resolveEarlyLinuxElectronOptions({
      env: {
        XDG_CURRENT_DESKTOP: "gamescope",
        XDG_DATA_HOME: "relative",
        XDG_DATA_DIRS: "/usr/share",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString,
      fileExists: (path) => {
        assert.equal(path, "/home/user/.local/share/kwalletd/kdewallet.kwl");
        return true;
      },
    });
    assert.equal(fallbackHome.passwordStore, "kwallet6");

    const ignoredDirectory = resolveEarlyLinuxElectronOptions({
      env: {
        XDG_CURRENT_DESKTOP: "gamescope",
        XDG_DATA_DIRS: "relative",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString,
    });
    assert.equal(ignoredDirectory.passwordStore, "gnome-libsecret");
  });

  it("keeps implicit development state under ~/.t3/dev when T3CODE_HOME is unset", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  it("treats whitespace-only T3CODE_HOME as unconfigured in development", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        T3CODE_HOME: "   ",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "gnome-libsecret" });
      },
    });

    assert.equal(preference, "gnome-libsecret");
  });
});

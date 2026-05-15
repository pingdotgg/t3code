import { assert, describe, it } from "@effect/vitest";

import {
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
} from "./DesktopEarlyElectronStartup.ts";

describe("DesktopEarlyElectronStartup", () => {
  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
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
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches and DBus fallback", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        XDG_RUNTIME_DIR: "/run/user/1000",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      exists: (path) => path === "/run/user/1000/bus",
      homeDirectory: "/home/user",
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
      uid: 1000,
    });

    assert.deepEqual(options, {
      dbusSessionBusAddress: "unix:path=/run/user/1000/bus",
      linuxWmClass: "t3code-dev",
      passwordStore: "gnome-libsecret",
    });
  });
});

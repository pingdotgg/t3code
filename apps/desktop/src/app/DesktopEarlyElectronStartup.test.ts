// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  restoreEarlyLinuxDeviceScaleFactor,
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

describe("Linux device scale across update relaunches", () => {
  const input = {
    env: { T3CODE_HOME: "/isolated" },
    homeDirectory: "/home/user",
    joinPath: NodePath.posix.join,
  };

  it("restores the exact explicit scale on a subsequent launch without arguments", () => {
    let saved = "";
    const applied: Array<[string, string]> = [];
    const launch = (explicit: string | null) =>
      restoreEarlyLinuxDeviceScaleFactor({
        ...input,
        commandLine: {
          hasSwitch: () => explicit !== null,
          getSwitchValue: () => explicit ?? "",
          appendSwitch: (name, value) => applied.push([name, value]),
        },
        readFileString: () => saved,
        writeFileString: (path, value) => {
          assert.equal(path, "/isolated/userdata/linux-device-scale-factor");
          saved = value;
        },
      });
    launch("1.75");
    assert.deepEqual(applied, []);
    launch(null);
    assert.deepEqual(applied, [["force-device-scale-factor", "1.75"]]);
    launch("1");
    launch(null);
    assert.deepEqual(applied.at(-1), ["force-device-scale-factor", "1"]);
  });

  for (const value of ["", "garbage", "0", "-1", "Infinity", "NaN"]) {
    it(`ignores invalid persisted scale ${JSON.stringify(value)}`, () => {
      const applied: Array<[string, string]> = [];
      restoreEarlyLinuxDeviceScaleFactor({
        ...input,
        commandLine: {
          hasSwitch: () => false,
          getSwitchValue: () => "",
          appendSwitch: (name, scale) => applied.push([name, scale]),
        },
        readFileString: () => value,
        writeFileString: () => assert.fail("unexpected write"),
      });
      assert.deepEqual(applied, []);
    });
  }

  it("preserves explicit switches even when persistence fails", () => {
    restoreEarlyLinuxDeviceScaleFactor({
      ...input,
      commandLine: {
        hasSwitch: () => true,
        getSwitchValue: () => "2",
        appendSwitch: () => assert.fail("explicit scale overridden"),
      },
      readFileString: () => assert.fail("explicit scale must take precedence"),
      writeFileString: () => {
        throw new Error("read-only");
      },
    });
  });

  it("keeps default scaling when state is missing", () => {
    restoreEarlyLinuxDeviceScaleFactor({
      ...input,
      commandLine: {
        hasSwitch: () => false,
        getSwitchValue: () => "",
        appendSwitch: () => assert.fail("default scale overridden"),
      },
      readFileString: () => {
        throw new Error("missing");
      },
      writeFileString: () => assert.fail("unexpected write"),
    });
  });
});

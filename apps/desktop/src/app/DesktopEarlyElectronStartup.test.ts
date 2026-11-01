// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  restoreEarlyLinuxDeviceScaleFactor,
  resolveEarlyLinuxPasswordStorePreference,
  resolveLinuxDisableFeaturesSwitch,
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

  describe("resolveLinuxDisableFeaturesSwitch", () => {
    const hyprland = { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland" };
    const releaseCommits: Record<string, string> = {
      "0.48.0": "5ee35f914f921e5696030698e74fb5566a804768",
      "0.48.1": "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
      "0.50.1": "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc",
    };
    const hyprctlVersion =
      (version: string, overrides: Record<string, unknown> = {}) =>
      () =>
        JSON.stringify({
          commit: releaseCommits[version] ?? "0123456789abcdef0123456789abcdef01234567",
          version,
          dirty: false,
          tag: `v${version}`,
          flags: [],
          ...overrides,
        });
    const brokenHyprland = {
      env: hyprland,
      ozonePlatform: "wayland",
      enableFeatures: null,
      disableFeatures: null,
      readHyprctlVersionJson: hyprctlVersion("0.48.1"),
    };

    it.each(["0.48.0", "0.50.1"])("disables the color manager on Hyprland %s", (version) => {
      assert.equal(
        resolveLinuxDisableFeaturesSwitch({
          ...brokenHyprland,
          readHyprctlVersionJson: hyprctlVersion(version),
        }),
        "WaylandWpColorManagerV1",
      );
    });

    it.each([
      { label: "case-insensitive desktop tokens", env: { XDG_CURRENT_DESKTOP: "foo:HYPRLAND" } },
      {
        label: "XDG_SESSION_DESKTOP when XDG_CURRENT_DESKTOP is unset",
        env: { XDG_SESSION_DESKTOP: "hyprland" },
      },
    ])("detects Hyprland via $label", ({ env }) => {
      assert.equal(
        resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, env }),
        "WaylandWpColorManagerV1",
      );
    });

    it.each([
      {
        label: "a stale Hyprland signature in KDE",
        env: { XDG_CURRENT_DESKTOP: "KDE", HYPRLAND_INSTANCE_SIGNATURE: "abc_123" },
      },
      {
        label: "resolved X11 in a Wayland session",
        ozonePlatform: "x11",
        env: { ...hyprland, WAYLAND_DISPLAY: "wayland-1" },
      },
      { label: "a missing platform", ozonePlatform: null },
      { label: "an unrelated platform", ozonePlatform: "headless" },
      { label: "already disabled features", disableFeatures: "Vulkan, WaylandWpColorManagerV1" },
      { label: "an explicitly enabled feature", enableFeatures: "Vulkan,WaylandWpColorManagerV1" },
      {
        label: "a feature enabled with trial parameters",
        enableFeatures: "*WaylandWpColorManagerV1<Study.Group:mode/strict",
      },
    ])("skips the Hyprland probe for $label", (overrides) => {
      assert.isNull(
        resolveLinuxDisableFeaturesSwitch({
          ...brokenHyprland,
          ...overrides,
          readHyprctlVersionJson: () => assert.fail("hyprctl should not run"),
        }),
      );
    });
  });
});

describe("Linux device scale persistence failures", () => {
  const input = {
    env: { T3CODE_HOME: "/isolated" },
    homeDirectory: "/home/user",
    joinPath: NodePath.posix.join,
  };

  it.each(["0", "Infinity", "garbage"])("ignores invalid persisted scale %j", (value) => {
    const applied: Array<[string, string]> = [];
    const writes: Array<string> = [];
    restoreEarlyLinuxDeviceScaleFactor({
      ...input,
      commandLine: {
        hasSwitch: () => false,
        getSwitchValue: () => "",
        appendSwitch: (name, scale) => applied.push([name, scale]),
      },
      readFileString: () => value,
      writeFileString: (_path, contents) => writes.push(contents),
    });
    assert.deepEqual(applied, []);
    assert.deepEqual(writes, []);
  });

  it("keeps startup available with default scaling when saved state cannot be read", () => {
    const applied: Array<[string, string]> = [];
    restoreEarlyLinuxDeviceScaleFactor({
      ...input,
      commandLine: {
        hasSwitch: () => false,
        getSwitchValue: () => "",
        appendSwitch: (name, value) => applied.push([name, value]),
      },
      readFileString: () => {
        throw new Error("ENOENT");
      },
      writeFileString: () => {},
    });
    assert.deepEqual(applied, []);
  });

  it("keeps an explicit scale when saving it fails, without falling back to saved state", () => {
    const applied: Array<[string, string]> = [];
    const reads: Array<string> = [];
    const writes: Array<string> = [];
    restoreEarlyLinuxDeviceScaleFactor({
      ...input,
      commandLine: {
        hasSwitch: () => true,
        getSwitchValue: () => "1",
        appendSwitch: (name, value) => applied.push([name, value]),
      },
      readFileString: (path) => {
        reads.push(path);
        return "1.75";
      },
      writeFileString: (_path, value) => {
        writes.push(value);
        throw new Error("EACCES");
      },
    });
    assert.deepEqual(writes, ["1"]);
    assert.deepEqual(reads, []);
    assert.deepEqual(applied, []);
  });
});
